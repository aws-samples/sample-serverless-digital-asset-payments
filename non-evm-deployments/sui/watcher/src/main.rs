use anyhow::Result;
use aws_config::BehaviorVersion;
use aws_sdk_dynamodb::{types::AttributeValue, Client as DynamoClient};
use aws_sdk_sns::Client as SnsClient;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use serde::Deserialize;
use shared::Invoice;
use sui_sdk::SuiClientBuilder;
use sui_types::base_types::SuiAddress;

#[derive(Deserialize)]
struct EventBridgeEvent {
    #[serde(default)]
    #[allow(dead_code)]
    version: String,
    #[serde(default)]
    #[allow(dead_code)]
    id: String,
}

async fn check_payments(
    _event: LambdaEvent<EventBridgeEvent>,
    dynamo: &DynamoClient,
    sns: &SnsClient,
) -> Result<String, Error> {
    eprintln!("🔍 Watcher started");
    
    
    let rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".to_string());
    
    let sui_client = SuiClientBuilder::default()
        .build(&rpc_url)
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    eprintln!("✓ SUI client connected");
    
    let response = dynamo
        .query()
        .table_name(Invoice::table_name())
        .index_name("status-index")
        .key_condition_expression("#status = :pending")
        .expression_attribute_names("#status", "status")
        .expression_attribute_values(":pending", AttributeValue::S("pending".to_string()))
        .send()
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    
    let items = response.items();
    eprintln!("📋 Found {} pending invoices", items.len());
    
    
    let mut payments_detected = 0;
    
    for item in items {
        let invoice_id: String = match item.get("invoice_id").and_then(|v| v.as_s().ok()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        
        // Skip expired invoices
        let expiry: i64 = item.get("expiry")
            .and_then(|v| v.as_n().ok())
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        if expiry > 0 && now > expiry {
            eprintln!("⏰ Invoice {} expired, marking as expired", invoice_id);
            let _ = dynamo
                .update_item()
                .table_name(Invoice::table_name())
                .key("invoice_id", AttributeValue::S(invoice_id.clone()))
                .update_expression("SET #status = :expired")
                .expression_attribute_names("#status", "status")
                .expression_attribute_values(":expired", AttributeValue::S("expired".to_string()))
                .send()
                .await;
            continue;
        }
        
        let address: String = match item.get("recipient_address").and_then(|v| v.as_s().ok()) {
            Some(addr) => addr.to_string(),
            None => continue,
        };
        
        let expected_amount: f64 = match item.get("amount")
            .and_then(|v| v.as_n().ok())
            .and_then(|n| n.parse().ok()) {
            Some(amt) => amt,
            None => continue,
        };

        // Check if this is a token invoice
        let token_type = item.get("token_type")
            .and_then(|v| v.as_s().ok())
            .map(|s| s.to_string());

        let token_address = item.get("token_address")
            .and_then(|v| v.as_s().ok())
            .map(|s| s.to_string());

        let token_decimals: u8 = item.get("token_decimals")
            .and_then(|v| v.as_n().ok())
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);

        // Convert human-readable amount to native units for balance comparison.
        // Native SUI: multiply by 1e9 (MIST). Tokens: multiply by 10^decimals.
        let expected_native: u128 = if token_type.as_deref() == Some("token") {
            (expected_amount * 10f64.powi(token_decimals as i32)).round() as u128
        } else {
            (expected_amount * 1_000_000_000.0).round() as u128
        };
        
        eprintln!("🔎 Checking invoice {} at address {} (type: {:?})", 
            invoice_id, address, token_type.as_deref().unwrap_or("native"));
        
        let sui_address: SuiAddress = match address.parse() {
            Ok(addr) => addr,
            Err(e) => {
                eprintln!("❌ Invalid address: {}", e);
                continue;
            }
        };
        
        // Check balance based on token type
        let balance = if token_type.as_deref() == Some("token") && token_address.is_some() {
            // Token balance check
            let token_addr = token_address.as_ref().unwrap();
            eprintln!("🪙 Checking token balance for {}", token_addr);
            
            match sui_client
                .coin_read_api()
                .get_balance(sui_address, Some(token_addr.clone()))
                .await {
                Ok(bal) => bal.total_balance,
                Err(e) => {
                    eprintln!("❌ Failed to get token balance: {}", e);
                    continue;
                }
            }
        } else {
            // Native SUI balance check
            match sui_client
                .coin_read_api()
                .get_balance(sui_address, None)
                .await {
                Ok(bal) => bal.total_balance,
                Err(e) => {
                    eprintln!("❌ Failed to get balance: {}", e);
                    continue;
                }
            }
        };
        
        eprintln!("💰 Balance: {} (expected native units: {})", balance, expected_native);

        if balance >= expected_native {
            eprintln!("✅ Payment detected for invoice {}", invoice_id);
            payments_detected += 1;
            
            dynamo
                .update_item()
                .table_name(Invoice::table_name())
                .key("invoice_id", AttributeValue::S(invoice_id.to_string()))
                .update_expression("SET #status = :paid")
                .expression_attribute_names("#status", "status")
                .expression_attribute_values(":paid", AttributeValue::S("paid".to_string()))
                .send()
                .await
                .map_err(|e| Error::from(e.to_string()))?;
            
            sns.publish()
                .topic_arn(std::env::var("SNS_TOPIC_ARN").map_err(|e| Error::from(e.to_string()))?)
                .message(format!("Payment received for invoice {}", invoice_id))
                .send()
                .await
                .map_err(|e| Error::from(e.to_string()))?;
        }
    }
    
    eprintln!("✓ Watcher completed: {} payments detected", payments_detected);
    Ok(format!("Checked {} invoices, detected {} payments", items.len(), payments_detected))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let dynamo = DynamoClient::new(&config);
    let sns = SnsClient::new(&config);
    
    lambda_runtime::run(service_fn(|event| {
        let dynamo = dynamo.clone();
        let sns = sns.clone();
        async move { check_payments(event, &dynamo, &sns).await }
    }))
    .await
}
