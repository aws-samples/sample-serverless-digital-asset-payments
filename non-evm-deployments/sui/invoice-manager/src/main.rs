use aws_config::BehaviorVersion;
use aws_sdk_dynamodb::{types::AttributeValue, Client as DynamoClient};
use lambda_http::{run, service_fn, Body, Error, Request, RequestExt, Response};
use serde::Deserialize;
use shared::Invoice;

#[derive(Deserialize)]
struct UpdateInvoiceRequest {
    status: String,
}

async fn handle_request(event: Request, dynamo: &DynamoClient) -> Result<Response<Body>, Error> {
    let path = event.uri().path().to_string();
    let path_without_stage = path.strip_prefix("/prod").unwrap_or(&path);
    eprintln!("🔍 Request: {} {}", event.method(), path_without_stage);
    let method = event.method().as_str().to_string();
    
    let result = match (method.as_str(), path_without_stage) {
        ("GET", "/invoices") => list_invoices(event, dynamo).await,
        ("GET", p) if p.starts_with("/invoices/") => get_invoice(p, dynamo).await,
        ("PUT", p) if p.starts_with("/invoices/") => update_invoice(p, event, dynamo).await,
        ("DELETE", p) if p.starts_with("/invoices/") => delete_invoice(p, dynamo).await,
        _ => Ok(Response::builder()
            .status(404)
            .body(Body::from(r#"{"error":"Not found"}"#))
            .unwrap()),
    };
    
    eprintln!("✓ Request completed");
    result
}

async fn list_invoices(event: Request, dynamo: &DynamoClient) -> Result<Response<Body>, Error> {
    eprintln!("📋 Listing invoices");
    let query_params = event.query_string_parameters();
    
    let status = query_params.first("status").map(|s| s.to_string());
    let limit = query_params.first("limit")
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(50)
        .min(100);
    
    eprintln!("   Status filter: {:?}, Limit: {}", status, limit);
    
    let mut request = dynamo.scan().table_name(Invoice::table_name()).limit(limit);
    
    if let Some(status_filter) = status {
        request = request
            .filter_expression("#status = :status")
            .expression_attribute_names("#status", "status")
            .expression_attribute_values(":status", AttributeValue::S(status_filter));
    }
    
    if let Some(last_key) = query_params.first("lastKey") {
        request = request.exclusive_start_key("invoice_id", AttributeValue::S(last_key.to_string()));
    }
    
    let response = request.send().await.map_err(|e| Error::from(e.to_string()))?;
    
    eprintln!("   Found {} items", response.items().len());
    
    let invoices: Vec<serde_json::Value> = response.items()
        .iter()
        .filter_map(|item| {
            let mut obj = serde_json::Map::new();
            for (k, v) in item {
                if let Some(val) = attribute_to_json(v) {
                    obj.insert(k.clone(), val);
                }
            }
            Some(serde_json::Value::Object(obj))
        })
        .collect();
    
    let last_key = response.last_evaluated_key()
        .and_then(|k| k.get("invoice_id"))
        .and_then(|v| v.as_s().ok())
        .map(|s| s.to_string());
    
    let result = serde_json::json!({
        "invoices": invoices,
        "lastKey": last_key
    });
    
    Ok(Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Body::from(result.to_string()))
        .unwrap())
}

fn attribute_to_json(attr: &AttributeValue) -> Option<serde_json::Value> {
    match attr {
        AttributeValue::S(s) => Some(serde_json::Value::String(s.clone())),
        AttributeValue::N(n) => n.parse::<f64>().ok().map(serde_json::Value::from),
        AttributeValue::Bool(b) => Some(serde_json::Value::Bool(*b)),
        _ => None,
    }
}

async fn get_invoice(path: &str, dynamo: &DynamoClient) -> Result<Response<Body>, Error> {
    let invoice_id = path.trim_start_matches("/invoices/");
    
    let response = dynamo
        .get_item()
        .table_name(Invoice::table_name())
        .key("invoice_id", AttributeValue::S(invoice_id.to_string()))
        .send()
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    
    match response.item() {
        Some(item) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in item {
                if let Some(val) = attribute_to_json(v) {
                    obj.insert(k.clone(), val);
                }
            }
            let body = serde_json::to_string(&serde_json::Value::Object(obj))
                .map_err(|e| Error::from(e.to_string()))?;
            Ok(Response::builder()
                .status(200)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap())
        }
        None => Ok(Response::builder()
            .status(404)
            .body(Body::from(r#"{"error":"Invoice not found"}"#))
            .unwrap()),
    }
}

async fn update_invoice(path: &str, event: Request, dynamo: &DynamoClient) -> Result<Response<Body>, Error> {
    let invoice_id = path.trim_start_matches("/invoices/");
    
    let body = std::str::from_utf8(event.body().as_ref())
        .map_err(|e| Error::from(e.to_string()))?;
    let update_req: UpdateInvoiceRequest = serde_json::from_str(body)
        .map_err(|e| Error::from(e.to_string()))?;
    
    // Get current invoice
    let current = dynamo
        .get_item()
        .table_name(Invoice::table_name())
        .key("invoice_id", AttributeValue::S(invoice_id.to_string()))
        .send()
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    
    let current_status = current.item()
        .and_then(|item| item.get("status"))
        .and_then(|v| v.as_s().ok())
        .ok_or_else(|| Error::from("Invoice not found"))?;
    
    // Only allow pending <-> cancelled transitions
    let valid_transition = matches!(
        (current_status.as_str(), update_req.status.as_str()),
        ("pending", "cancelled") | ("cancelled", "pending")
    );
    
    if !valid_transition {
        return Ok(Response::builder()
            .status(400)
            .body(Body::from(r#"{"error":"Invalid status transition. Only pending <-> cancelled allowed"}"#))
            .unwrap());
    }
    
    dynamo
        .update_item()
        .table_name(Invoice::table_name())
        .key("invoice_id", AttributeValue::S(invoice_id.to_string()))
        .update_expression("SET #status = :status")
        .expression_attribute_names("#status", "status")
        .expression_attribute_values(":status", AttributeValue::S(update_req.status))
        .send()
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    
    Ok(Response::builder()
        .status(200)
        .body(Body::from(r#"{"message":"Invoice updated"}"#))
        .unwrap())
}

async fn delete_invoice(path: &str, dynamo: &DynamoClient) -> Result<Response<Body>, Error> {
    let invoice_id = path.trim_start_matches("/invoices/");
    
    // Check if invoice is pending
    let current = dynamo
        .get_item()
        .table_name(Invoice::table_name())
        .key("invoice_id", AttributeValue::S(invoice_id.to_string()))
        .send()
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    
    let current_status = current.item()
        .and_then(|item| item.get("status"))
        .and_then(|v| v.as_s().ok())
        .ok_or_else(|| Error::from("Invoice not found"))?;
    
    if current_status != "pending" && current_status != "cancelled" {
        return Ok(Response::builder()
            .status(400)
            .body(Body::from(r#"{"error":"Can only delete pending or cancelled invoices"}"#))
            .unwrap());
    }
    
    dynamo
        .delete_item()
        .table_name(Invoice::table_name())
        .key("invoice_id", AttributeValue::S(invoice_id.to_string()))
        .send()
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    
    Ok(Response::builder()
        .status(200)
        .body(Body::from(r#"{"message":"Invoice deleted"}"#))
        .unwrap())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let dynamo = DynamoClient::new(&config);
    
    run(service_fn(|event| {
        let dynamo = dynamo.clone();
        async move { handle_request(event, &dynamo).await }
    }))
    .await
}
