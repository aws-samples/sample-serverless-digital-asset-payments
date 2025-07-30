const { SecretsManagerClient, PutSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const crypto = require('crypto');
const bip39 = require('bip39');
require('dotenv').config();

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });

const SECRET = process.env.SECRET_NAME;
const HOT_PK_SECRET_NAME = process.env.HOT_PK_SECRET_NAME;

const pk = process.env.HOT_WALLET_PK;
if (!pk) {
    throw new Error('Missing HOT_WALLET_PK environment variable');
}

(async () => {
    if (pk) {
        console.log('[PK] Saving hot‑wallet PK…');
        await sm.send(new PutSecretValueCommand({
            SecretId: HOT_PK_SECRET_NAME,
            SecretString: JSON.stringify({ pk: pk.replace(/^0x/, '') })
        }));
        console.log('✅ Hot‑wallet PK stored (encrypted automatically by Secrets Manager).');
    } else {
        console.warn('[SKIP] No HOT_WALLET_PK in .env – skipping hot‑wallet upload.');
    }

    // ---- Generate & store mnemonic ----
    console.log('[1/2] Generating entropy & mnemonic…');
    const entropy = crypto.randomBytes(32).toString('hex');
    const mnemonic = bip39.entropyToMnemonic(entropy);
    //console.log(`\n==== WRITE DOWN YOUR SEED ====\n${mnemonic}\n==============================\n`);

    console.log('[2/2] Saving mnemonic to Secrets Manager…');
    await sm.send(new PutSecretValueCommand({
        SecretId: SECRET,
        SecretString: JSON.stringify({ mnemonic })
    }));

    console.log('✅ Mnemonic stored (encrypted automatically by Secrets Manager).');
})();
