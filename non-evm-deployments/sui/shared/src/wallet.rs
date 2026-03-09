use anyhow::{Result, anyhow};
use aws_sdk_secretsmanager::Client as SecretsClient;
use sui_types::base_types::SuiAddress;
use sui_types::crypto::{SuiKeyPair, PublicKey, ToFromBytes};
use bip39::Mnemonic;
use slip10_ed25519::derive_ed25519_private_key;

pub async fn get_mnemonic(secrets_client: &SecretsClient, secret_name: &str) -> Result<String> {
    let response = secrets_client
        .get_secret_value()
        .secret_id(secret_name)
        .send()
        .await?;
    
    Ok(response.secret_string().unwrap().to_string())
}

// Derive SUI keypair from mnemonic using proper BIP44/SLIP-0010
// Path: m/44'/784'/{account}'/{change}'/{address_index}'
// For invoices: m/44'/784'/0'/0'/{index}'
pub fn derive_keypair(mnemonic_str: &str, index: u32) -> Result<SuiKeyPair> {
    // Parse and validate mnemonic
    let mnemonic = Mnemonic::parse(mnemonic_str)?;
    let seed = mnemonic.to_seed("");
    
    // SUI derivation path: m/44'/784'/0'/0'/{index}'
    // SLIP-0010 uses hardened derivation for all levels
    let path = &[
        44 | 0x80000000,  // purpose' (hardened)
        784 | 0x80000000, // coin_type' (SUI = 784, hardened)
        0 | 0x80000000,   // account' (hardened)
        0 | 0x80000000,   // change' (hardened)
        index | 0x80000000, // address_index' (hardened)
    ];
    
    // Derive Ed25519 private key using SLIP-0010
    let private_key_bytes = derive_ed25519_private_key(&seed, path);
    
    // Convert to fastcrypto Ed25519KeyPair
    let fc_keypair = fastcrypto::ed25519::Ed25519KeyPair::from_bytes(&private_key_bytes)
        .map_err(|e| anyhow!("Failed to create keypair: {:?}", e))?;
    
    Ok(SuiKeyPair::Ed25519(fc_keypair))
}

// Derive address from mnemonic at given index
pub fn derive_address(mnemonic_str: &str, index: u32) -> Result<SuiAddress> {
    let keypair = derive_keypair(mnemonic_str, index)?;
    let public_key: PublicKey = keypair.public();
    Ok(SuiAddress::from(&public_key))
}
