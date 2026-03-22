use aws_config::BehaviorVersion;
use aws_sdk_dynamodb::{Client as DynamoClient, types::AttributeValue};
use aws_sdk_secretsmanager::Client as SecretsClient;
use aws_sdk_sns::Client as SnsClient;
use aws_sdk_cloudwatch::{Client as CloudWatchClient, types::{MetricDatum, StandardUnit}};
use lambda_runtime::{service_fn, Error, LambdaEvent};
use serde::Deserialize;
use shared::{get_mnemonic, derive_keypair, Invoice};
use sui_sdk::{SuiClientBuilder, types::base_types::SuiAddress, rpc_types::SuiTransactionBlockResponseOptions};
use sui_types::crypto::Signer;
use sui_types::signature::GenericSignature;
use shared_crypto::intent::{Intent, IntentMessage};
use std::str::FromStr;
use fastcrypto::hash::HashFunction;

const MAX_RETRIES: u32 = 3;

#[derive(Deserialize)]
struct DynamoStreamEvent {
    #[serde(rename = "Records")]
    records: Vec<DynamoStreamRecord>,
}

#[derive(Deserialize)]
struct DynamoStreamRecord {
    dynamodb: DynamoStreamData,
}

#[derive(Deserialize)]
struct DynamoStreamData {
    #[serde(rename = "NewImage")]
    new_image: Option<serde_json::Value>,
}

async fn sweep_funds(
    event: LambdaEvent<DynamoStreamEvent>,
    dynamo: &DynamoClient,
    secrets: &SecretsClient,
    sns: &SnsClient,
    cloudwatch: &CloudWatchClient,
) -> Result<String, Error> {
    eprintln!("🚀 Sweeper started");
    let treasury_address = std::env::var("TREASURY_ADDRESS")
        .map_err(|_| Error::from("TREASURY_ADDRESS environment variable is required"))?;
    let treasury_sui_address = SuiAddress::from_str(&treasury_address)
        .map_err(|e| Error::from(format!("Invalid treasury address: {}", e)))?;
    eprintln!("✓ Treasury address: {}", treasury_address);
    
    let mnemonic = get_mnemonic(secrets, "sui-payment-mnemonic").await
        .map_err(|e| Error::from(e.to_string()))?;
    eprintln!("✓ Got mnemonic");
    
    let rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".to_string());
    
    let sui_client = SuiClientBuilder::default()
        .build(&rpc_url)
        .await
        .map_err(|e| Error::from(format!("Failed to create SUI client: {}", e)))?;
    eprintln!("✓ Created SUI client");
    
    let mut swept_count = 0;
    eprintln!("📋 Processing {} records", event.payload.records.len());
    
    for record in event.payload.records {
        if let Some(new_image) = record.dynamodb.new_image {
            let status = new_image.get("status")
                .and_then(|v| v.get("S"))
                .and_then(|v| v.as_str());
            
            eprintln!("📝 Record status: {:?}", status);
            
            if status == Some("paid") {
                let invoice_id = new_image.get("invoice_id")
                    .and_then(|v| v.get("S"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                
                // Check retry count
                let retry_count: u32 = new_image.get("retry_count")
                    .and_then(|v| v.get("N"))
                    .and_then(|v| v.as_str())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                
                if retry_count >= MAX_RETRIES {
                    eprintln!("❌ Invoice {} exceeded max retries ({}), marking as failed", invoice_id, retry_count);
                    
                    let error_msg = format!("Exceeded max retries ({})", MAX_RETRIES);
                    
                    // Mark as failed in DynamoDB
                    if let Err(e) = dynamo.update_item()
                        .table_name(Invoice::table_name())
                        .key("invoice_id", AttributeValue::S(invoice_id.to_string()))
                        .update_expression("SET #status = :failed, last_error = :error")
                        .expression_attribute_names("#status", "status")
                        .expression_attribute_values(":failed", AttributeValue::S("failed".to_string()))
                        .expression_attribute_values(":error", AttributeValue::S(error_msg.clone()))
                        .send()
                        .await {
                        eprintln!("⚠️  Failed to update invoice status: {}", e);
                    }
                    
                    // Send SNS alert
                    if let Some(alert_topic_arn) = std::env::var("ALERT_TOPIC_ARN").ok() {
                        let last_error = new_image.get("last_error")
                            .and_then(|v| v.get("S"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("Unknown error");
                        
                        let message = format!(
                            "🚨 SUI Payment Alert - Invoice Failed\n\n\
                            Invoice ID: {}\n\
                            Recipient Address: {}\n\
                            Amount: {} MIST\n\
                            Attempts: {}/{}\n\
                            Last Error: {}\n\
                            Status: failed\n\n\
                            Action Required: Manual investigation needed.",
                            invoice_id,
                            new_image.get("recipient_address")
                                .and_then(|v| v.get("S"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown"),
                            new_image.get("amount")
                                .and_then(|v| v.get("N"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0"),
                            retry_count,
                            MAX_RETRIES,
                            last_error
                        );
                        
                        if let Err(e) = sns.publish()
                            .topic_arn(&alert_topic_arn)
                            .subject("SUI Payment Alert - Invoice Failed")
                            .message(&message)
                            .send()
                            .await {
                            eprintln!("⚠️  Failed to send SNS alert: {}", e);
                        } else {
                            eprintln!("📧 Alert sent to SNS topic");
                        }
                    }
                    
                    // Publish failed sweep metric
                    let _ = cloudwatch.put_metric_data()
                        .namespace("SUIPayment")
                        .metric_data(
                            MetricDatum::builder()
                                .metric_name("SweepsFailed")
                                .value(1.0)
                                .unit(StandardUnit::Count)
                                .build()
                        )
                        .send()
                        .await;
                    
                    continue;
                }
                
                let wallet_index: u32 = new_image.get("wallet_index")
                    .and_then(|v| v.get("N"))
                    .and_then(|v| v.as_str())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                
                let recipient_address = new_image.get("recipient_address")
                    .and_then(|v| v.get("S"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                
                let from_address = SuiAddress::from_str(recipient_address)
                    .map_err(|e| Error::from(format!("Invalid recipient address: {}", e)))?;
                
                let amount: u64 = new_image.get("amount")
                    .and_then(|v| v.get("N"))
                    .and_then(|v| v.as_str())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                
                // Check if this is a token invoice
                let token_type = new_image.get("token_type")
                    .and_then(|v| v.get("S"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                
                let token_address = new_image.get("token_address")
                    .and_then(|v| v.get("S"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                
                let is_token = token_type.as_deref() == Some("token") && token_address.is_some();
                
                eprintln!("🔄 Sweeping invoice {} (attempt {}/{})", invoice_id, retry_count + 1, MAX_RETRIES);
                eprintln!("   From: {} (index {})", recipient_address, wallet_index);
                eprintln!("   To: {}", treasury_address);
                eprintln!("   Amount: {}", amount);
                eprintln!("   Type: {}", if is_token { "Token" } else { "Native SUI" });
                
                // Derive keypair for signing
                let keypair = derive_keypair(&mnemonic, wallet_index)
                    .map_err(|e| Error::from(format!("Failed to derive keypair: {}", e)))?;
                let derived_address = SuiAddress::from(&keypair.public());
                eprintln!("   ✓ Derived keypair for address: {}", derived_address);
                
                if derived_address != from_address {
                    eprintln!("   ❌ ERROR: Derived address {} doesn't match expected {}", derived_address, from_address);
                    continue;
                }
                
                // Get coins at address (native SUI or tokens)
                let coin_type = if is_token {
                    token_address.as_ref().unwrap().clone()
                } else {
                    "0x2::sui::SUI".to_string() // Native SUI type
                };
                
                let coins = sui_client.coin_read_api()
                    .get_coins(from_address, Some(coin_type.clone()), None, None)
                    .await
                    .map_err(|e| Error::from(format!("Failed to get coins: {}", e)))?;
                eprintln!("   ✓ Found {} coins of type {}", coins.data.len(), coin_type);
                
                if coins.data.is_empty() {
                    eprintln!("   ⚠️  No coins found at address");
                    continue;
                }
                
                // Get gas coin (always native SUI)
                let gas_coins = sui_client.coin_read_api()
                    .get_coins(from_address, None, None, None)
                    .await
                    .map_err(|e| Error::from(format!("Failed to get gas coins: {}", e)))?;
                
                if gas_coins.data.is_empty() {
                    eprintln!("   ⚠️  No gas coins found at address");
                    continue;
                }
                
                let gas_coin = gas_coins.data[0].coin_object_id;
                
                // Get gas price
                let gas_price = sui_client.read_api()
                    .get_reference_gas_price()
                    .await
                    .map_err(|e| Error::from(format!("Failed to get gas price: {}", e)))?;
                
                // Build transfer transaction
                let gas_budget = gas_price * 10000;
                eprintln!("   ✓ Gas price: {}, budget: {}", gas_price, gas_budget);
                
                let tx_data = if is_token {
                    // Token transfer using Move contract calls
                    eprintln!("   ℹ️  Building token transfer transaction");
                    
                    use sui_types::transaction::TransactionData;
                    use sui_types::programmable_transaction_builder::ProgrammableTransactionBuilder;
                    use sui_types::transaction::CallArg;
                    use sui_types::transaction::ObjectArg;
                    
                    let mut ptb = ProgrammableTransactionBuilder::new();
                    
                    // Add all token coins as input objects
                    let mut coin_args = Vec::new();
                    for coin in &coins.data {
                        let obj_ref = (coin.coin_object_id, coin.version, coin.digest);
                        let obj_arg = ObjectArg::ImmOrOwnedObject(obj_ref);
                        let arg = ptb.input(CallArg::Object(obj_arg))
                            .map_err(|e| Error::from(format!("Failed to add coin input: {}", e)))?;
                        coin_args.push(arg);
                    }
                    
                    // Merge all coins into the first one if multiple
                    let merged_coin = if coin_args.len() > 1 {
                        eprintln!("   ℹ️  Merging {} token coins", coin_args.len());
                        ptb.command(sui_types::transaction::Command::MergeCoins(
                            coin_args[0],
                            coin_args[1..].to_vec(),
                        ));
                        coin_args[0]
                    } else {
                        coin_args[0]
                    };
                    
                    // Transfer the merged coin to treasury
                    let recipient_arg = ptb.input(CallArg::Pure(bcs::to_bytes(&treasury_sui_address).unwrap()))
                        .map_err(|e| Error::from(format!("Failed to add recipient: {}", e)))?;
                    
                    ptb.command(sui_types::transaction::Command::TransferObjects(
                        vec![merged_coin],
                        recipient_arg,
                    ));
                    
                    let pt = ptb.finish();
                    
                    // Get gas coin reference
                    let gas_coin_ref = gas_coins.data.iter()
                        .find(|c| c.coin_object_id == gas_coin)
                        .ok_or_else(|| Error::from("Gas coin not found"))?;
                    
                    TransactionData::new_programmable(
                        from_address,
                        vec![(gas_coin, gas_coin_ref.version, gas_coin_ref.digest)],
                        pt,
                        gas_budget,
                        gas_price,
                    )
                } else {
                    // Native SUI transfer
                    sui_client.transaction_builder()
                        .transfer_sui(from_address, gas_coin, gas_budget, treasury_sui_address, Some(amount))
                        .await
                        .map_err(|e| Error::from(format!("Failed to build transaction: {}", e)))?
                };
                eprintln!("   ✓ Built transaction");
                
                // Create intent message and sign
                let intent_msg = IntentMessage::new(Intent::sui_transaction(), tx_data);
                let raw_tx = bcs::to_bytes(&intent_msg).expect("bcs should not fail");
                let mut hasher = sui_types::crypto::DefaultHash::default();
                hasher.update(&raw_tx);
                let digest = hasher.finalize().digest;
                
                // TODO: KMS Integration
                // AWS KMS does not natively support Ed25519 signing (required for SUI)
                // Options for production:
                // 1. Use AWS CloudHSM (supports Ed25519)
                // 2. Use KMS with ECDSA and convert to Ed25519 (complex)
                // 3. Use external HSM with Ed25519 support
                // For now, using in-memory signing with Secrets Manager
                
                let sui_sig = keypair.sign(&digest);
                eprintln!("   ✓ Signed transaction");
                
                // Execute transaction
                eprintln!("   → Executing transaction...");
                let response = match sui_client.quorum_driver_api()
                    .execute_transaction_block(
                        sui_types::transaction::Transaction::from_generic_sig_data(
                            intent_msg.value,
                            vec![GenericSignature::Signature(sui_sig)],
                        ),
                        SuiTransactionBlockResponseOptions::default(),
                        None,
                    )
                    .await {
                        Ok(r) => r,
                        Err(e) => {
                            let error_msg = format!("Transaction execution failed: {}", e);
                            eprintln!("   ❌ {}", error_msg);
                            
                            // Increment retry count and save error
                            if let Err(update_err) = dynamo.update_item()
                                .table_name(Invoice::table_name())
                                .key("invoice_id", AttributeValue::S(invoice_id.to_string()))
                                .update_expression("SET retry_count = :count, last_error = :error, updated_at = :time")
                                .expression_attribute_values(":count", AttributeValue::N((retry_count + 1).to_string()))
                                .expression_attribute_values(":error", AttributeValue::S(error_msg))
                                .expression_attribute_values(":time", AttributeValue::N(chrono::Utc::now().timestamp().to_string()))
                                .send()
                                .await {
                                eprintln!("   ⚠️  Failed to update retry count: {}", update_err);
                            } else {
                                eprintln!("   ℹ️  Retry count incremented to {}", retry_count + 1);
                            }
                            continue;
                        }
                    };
                
                let tx_digest = response.digest.to_string();
                eprintln!("   ✅ Swept! TX: {}", tx_digest);
                
                // Publish successful sweep metric
                let _ = cloudwatch.put_metric_data()
                    .namespace("SUIPayment")
                    .metric_data(
                        MetricDatum::builder()
                            .metric_name("SweepsSuccessful")
                            .value(1.0)
                            .unit(StandardUnit::Count)
                            .build()
                    )
                    .send()
                    .await;
                
                // Update invoice status to "swept"
                dynamo.update_item()
                    .table_name(Invoice::table_name())
                    .key("invoice_id", AttributeValue::S(invoice_id.to_string()))
                    .update_expression("SET #status = :swept, tx_digest = :digest, retry_count = :zero, updated_at = :time")
                    .expression_attribute_names("#status", "status")
                    .expression_attribute_values(":swept", AttributeValue::S("swept".to_string()))
                    .expression_attribute_values(":digest", AttributeValue::S(tx_digest))
                    .expression_attribute_values(":zero", AttributeValue::N("0".to_string()))
                    .expression_attribute_values(":time", AttributeValue::N(chrono::Utc::now().timestamp().to_string()))
                    .send()
                    .await
                    .map_err(|e| Error::from(format!("Failed to update invoice: {}", e)))?;
                
                swept_count += 1;
            }
        }
    }
    
    Ok(format!("Successfully swept {} invoices", swept_count))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let dynamo = DynamoClient::new(&config);
    let secrets = SecretsClient::new(&config);
    let sns = SnsClient::new(&config);
    let cloudwatch = CloudWatchClient::new(&config);
    
    lambda_runtime::run(service_fn(|event| {
        let dynamo = dynamo.clone();
        let secrets = secrets.clone();
        let sns = sns.clone();
        let cloudwatch = cloudwatch.clone();
        async move { sweep_funds(event, &dynamo, &secrets, &sns, &cloudwatch).await }
    }))
    .await
}
