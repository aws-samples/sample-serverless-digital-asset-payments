use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invoice {
    pub invoice_id: String,
    pub amount: u64,
    pub recipient_address: String,
    pub expiry: i64,
    pub reference_id: String,
    pub status: InvoiceStatus,
    pub wallet_index: u32,
    pub created_at: i64,
    pub tx_digest: Option<String>,
    pub payer: Option<String>,
    pub timestamp: Option<i64>,
    // Token support
    pub token_type: Option<String>, // "native" or "token"
    pub token_address: Option<String>, // SUI Move token contract address
    pub token_symbol: Option<String>, // e.g., "USDC", "USDT"
    pub token_decimals: Option<u8>, // e.g., 6 for USDC
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InvoiceStatus {
    Pending,
    Paid,
    Swept,
    Expired,
    Cancelled,
}

impl Invoice {
    pub fn table_name() -> &'static str {
        "SuiInvoices"
    }
}
