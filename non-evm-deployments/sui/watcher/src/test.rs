use lambda_runtime::{service_fn, Error, LambdaEvent};
use serde_json::Value;

async fn handler(_event: LambdaEvent<Value>) -> Result<String, Error> {
    eprintln!("TEST: Handler called!");
    Ok("Test successful".to_string())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    eprintln!("TEST: Main starting");
    lambda_runtime::run(service_fn(handler)).await
}
