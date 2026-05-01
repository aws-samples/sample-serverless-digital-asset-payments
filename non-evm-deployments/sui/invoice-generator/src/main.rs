use anyhow::Result;
use aws_config::BehaviorVersion;
use aws_sdk_dynamodb::{types::AttributeValue, Client as DynamoClient};
use aws_sdk_secretsmanager::Client as SecretsClient;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared::{derive_address, get_mnemonic, Invoice, InvoiceStatus};
use std::collections::HashMap;
use base64::{Engine as _, engine::general_purpose};

// Token whitelist for production
// Add approved token addresses here
fn is_token_whitelisted(token_address: &str) -> bool {
    const WHITELISTED_TOKENS: &[&str] = &[
        // SUI Testnet USDC (Circle)
        "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
        // Add more approved tokens here
    ];

    WHITELISTED_TOKENS.contains(&token_address)
}

#[derive(Deserialize)]
struct CreateInvoiceRequest {
    amount: f64,
    reference_id: String,
    expiry_seconds: i64,
    #[serde(default)]
    token_type: Option<String>, // "native" or "token"
    #[serde(default)]
    token_address: Option<String>, // SUI Move token contract address
    #[serde(default)]
    token_symbol: Option<String>, // e.g., "USDC", "USDT"
    #[serde(default)]
    token_decimals: Option<u8>, // e.g., 6 for USDC
}

#[derive(Serialize)]
struct ApiGatewayResponse {
    #[serde(rename = "statusCode")]
    status_code: u16,
    body: String,
    headers: HashMap<String, String>,
}

#[derive(Serialize)]
struct CreateInvoiceResponse {
    invoice_id: String,
    recipient_address: String,
    amount: f64,
    expiry: i64,
    qr_code_base64: String,
}

async fn get_next_wallet_index(dynamo: &DynamoClient) -> Result<u32> {
    let response = dynamo
        .update_item()
        .table_name("SuiWalletCounter")
        .key("id", AttributeValue::S("counter".to_string()))
        .update_expression("ADD #idx :inc")
        .expression_attribute_names("#idx", "index")
        .expression_attribute_values(":inc", AttributeValue::N("1".to_string()))
        .return_values(aws_sdk_dynamodb::types::ReturnValue::UpdatedNew)
        .send()
        .await?;

    let index = response
        .attributes()
        .and_then(|attrs| attrs.get("index"))
        .and_then(|v| v.as_n().ok())
        .and_then(|n| n.parse::<u32>().ok())
        .unwrap_or(0);

    Ok(index)
}

async fn create_invoice(
    event: LambdaEvent<Value>,
    dynamo: &DynamoClient,
    secrets: &SecretsClient,
) -> Result<serde_json::Value, Error> {
    let body_str = event.payload.get("body")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::from("Missing body field"))?;
    
    let payload: CreateInvoiceRequest = serde_json::from_str(body_str)
        .map_err(|e| Error::from(format!("Invalid JSON: {}", e)))?;
    
    // Validate token parameters
    if let Some(token_type) = &payload.token_type {
        if token_type == "token" {
            // Require token address for token payments
            let token_address = payload.token_address.as_ref()
                .ok_or_else(|| Error::from("token_address required for token payments"))?;
            
            // Validate against whitelist
            if !is_token_whitelisted(token_address) {
                return Err(Error::from(format!("Token address not whitelisted: {}", token_address)));
            }
        }
    }
    
    let invoice_id = uuid::Uuid::new_v4().to_string();
    let wallet_index = get_next_wallet_index(dynamo).await
        .map_err(|e| Error::from(e.to_string()))?;
    
    let mnemonic = get_mnemonic(secrets, "sui-payment-mnemonic").await
        .map_err(|e| Error::from(e.to_string()))?;
    let recipient_address = derive_address(&mnemonic, wallet_index)
        .map_err(|e| Error::from(e.to_string()))?
        .to_string();
    
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| Error::from(e.to_string()))?
        .as_secs() as i64;
    let expiry = now + payload.expiry_seconds;
    
    let invoice = Invoice {
        invoice_id: invoice_id.clone(),
        amount: payload.amount,
        recipient_address: recipient_address.clone(),
        expiry,
        reference_id: payload.reference_id,
        status: InvoiceStatus::Pending,
        wallet_index,
        created_at: now,
        tx_digest: None,
        payer: None,
        timestamp: None,
        token_type: payload.token_type.clone(),
        token_address: payload.token_address.clone(),
        token_symbol: payload.token_symbol.clone(),
        token_decimals: payload.token_decimals,
    };
    
    let mut item = HashMap::new();
    item.insert("invoice_id".to_string(), AttributeValue::S(invoice.invoice_id.clone()));
    item.insert("amount".to_string(), AttributeValue::N(invoice.amount.to_string()));
    item.insert("recipient_address".to_string(), AttributeValue::S(invoice.recipient_address.clone()));
    item.insert("expiry".to_string(), AttributeValue::N(invoice.expiry.to_string()));
    item.insert("reference_id".to_string(), AttributeValue::S(invoice.reference_id.clone()));
    item.insert("status".to_string(), AttributeValue::S("pending".to_string()));
    item.insert("wallet_index".to_string(), AttributeValue::N(invoice.wallet_index.to_string()));
    item.insert("created_at".to_string(), AttributeValue::N(invoice.created_at.to_string()));
    
    // Add token fields if present
    if let Some(token_type) = &invoice.token_type {
        item.insert("token_type".to_string(), AttributeValue::S(token_type.clone()));
    }
    if let Some(token_address) = &invoice.token_address {
        item.insert("token_address".to_string(), AttributeValue::S(token_address.clone()));
    }
    if let Some(token_symbol) = &invoice.token_symbol {
        item.insert("token_symbol".to_string(), AttributeValue::S(token_symbol.clone()));
    }
    if let Some(token_decimals) = invoice.token_decimals {
        item.insert("token_decimals".to_string(), AttributeValue::N(token_decimals.to_string()));
    }
    
    dynamo
        .put_item()
        .table_name(Invoice::table_name())
        .set_item(Some(item))
        .send()
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    
    let qr_data = format!("sui:{}?amount={}", recipient_address, payload.amount);
    let qr = QrCode::new(qr_data.as_bytes())
        .map_err(|e| Error::from(e.to_string()))?;
    let qr_image = qr.render::<qrcode::render::unicode::Dense1x2>().build();
    let qr_base64 = general_purpose::STANDARD.encode(qr_image.as_bytes());
    
    let response_body = CreateInvoiceResponse {
        invoice_id,
        recipient_address,
        amount: payload.amount,
        expiry,
        qr_code_base64: qr_base64,
    };
    
    let mut headers = HashMap::new();
    headers.insert("Content-Type".to_string(), "application/json".to_string());
    
    let api_response = ApiGatewayResponse {
        status_code: 200,
        body: serde_json::to_string(&response_body).unwrap(),
        headers,
    };
    
    Ok(serde_json::to_value(api_response).unwrap())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let dynamo = DynamoClient::new(&config);
    let secrets = SecretsClient::new(&config);
    
    lambda_runtime::run(service_fn(|event| {
        let dynamo = dynamo.clone();
        let secrets = secrets.clone();
        async move { create_invoice(event, &dynamo, &secrets).await }
    }))
    .await
}
