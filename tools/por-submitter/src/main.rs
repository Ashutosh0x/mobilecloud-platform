//! por-submitter — native Soroban RPC submitter for the PoR contract
//! (production roadmap M3-pre). Bypasses stellar-cli's JSON/f64 argument
//! path to submit full 18-decimal u128 amounts (10^24 base units).
//!
//! Usage:
//!   por-submitter <contract_id_hex> <source_secret_S..> <tx_seq>
//!                 <attestation_seq> <epoch> <valid_until>
//!                 <reserves_u128> <supply_u128> <quorum.json> [rpc_url]
//!
//! quorum.json = por-attestor "quorum" stage: {"signers":[{public_key,signature}...]}

use ed25519_dalek::{Signature, Signer, SigningKey};
use sha2::{Digest, Sha256};
use soroban_sdk::xdr::{
    AccountId, DecoratedSignature, ExtensionPoint, Hash, HostFunction, InvokeContractArgs,
    InvokeHostFunctionOp, LedgerFootprint, Limited, Limits, Memo, MuxedAccount, Operation,
    OperationBody, Preconditions, PublicKey, ScMap, ScMapEntry, ScSymbol, ScVal, ScVec,
    SequenceNumber, Signature as XdrSignature, SignatureHint, SorobanResources,
    SorobanTransactionData, Transaction, TransactionEnvelope, TransactionExt,
    TransactionV1Envelope, Uint256, VecM, WriteXdr,
};
use stellar_rpc_client::Client as RpcClient;

const NETWORK_PASSPHRASE: &str = "Test SDF Network ; September 2015";
const DEFAULT_RPC: &str = "https://soroban-testnet.stellar.org";
const BASE_FEE_STROOPS: i64 = 1_000;
const ENVELOPE_TYPE_TX: u32 = 2; // classic transaction signature preimage tag

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 9 {
        eprintln!(
            "usage: por-submitter <contract_id_hex> <secret_S..> <tx_seq> <attestation_seq> \
             <epoch> <valid_until> <reserves_u128> <supply_u128> <quorum.json> [rpc_url]"
        );
        std::process::exit(2);
    }
    let contract_id: [u8; 32] = hex::decode(&a[0])?[..].try_into()?;
    let secret_seed = strkey_seed(&a[1])?;
    let tx_seq: i64 = a[2].parse()?;
    let attestation_seq: u64 = a[3].parse()?;
    let epoch: u64 = a[4].parse()?;
    let valid_until: u64 = a[5].parse()?;
    let reserves: u128 = a[6].parse()?;
    let supply: u128 = a[7].parse()?;
    let quorum_raw = std::fs::read_to_string(&a[8])?;
    let rpc_url = a.get(9).cloned().unwrap_or_else(|| DEFAULT_RPC.into());

    let signers = parse_quorum(&quorum_raw);
    assert!(!signers.is_empty(), "no signers parsed");

    let signing = SigningKey::from_bytes(&secret_seed);
    let pub_bytes = signing.verifying_key().to_bytes();
    let source = AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(pub_bytes)));

    // --- ScVal args: the 18-decimal amounts ride as true u128 XDR parts ---
    let mut sig_entries: Vec<ScVal> = Vec::new();
    for s in &signers {
        let pk = hex::decode(&s.0)?;
        let sig = hex::decode(&s.1)?;
        sig_entries.push(ScVal::Map(Some(ScMap(
            vec![
                ScMapEntry {
                    key: ScVal::Symbol(ScSymbol("public_key".try_into()?)),
                    val: ScVal::Bytes(pk.try_into()?),
                },
                ScMapEntry {
                    key: ScVal::Symbol(ScSymbol("signature".try_into()?)),
                    val: ScVal::Bytes(sig.try_into()?),
                },
            ]
            .try_into()?,
        ))));
    }
    let sig_vec = ScVal::Vec(Some(ScVec(sig_entries.try_into()?)));

    let args: VecM<ScVal, { u32::MAX }> = vec![
        ScVal::Symbol(ScSymbol("ANT".try_into()?)),
        ScVal::U64(attestation_seq),
        ScVal::U64(epoch),
        ScVal::U64(valid_until),
        ScVal::U128(soroban_sdk::xdr::UInt128Parts {
            hi: (reserves >> 64) as u64,
            lo: reserves as u64,
        }),
        ScVal::U128(soroban_sdk::xdr::UInt128Parts {
            hi: (supply >> 64) as u64,
            lo: supply as u64,
        }),
        sig_vec,
    ]
    .try_into()?;

    let op = Operation {
        source_account: None,
        body: OperationBody::InvokeHostFunction(InvokeHostFunctionOp {
            host_function: HostFunction::InvokeContract(InvokeContractArgs {
                contract_address: soroban_sdk::xdr::ScAddress::Contract(Hash(contract_id)),
                function_name: ScSymbol("submit_attestation".try_into()?),
                args,
            }),
            auth: VecM::default(),
        }),
    };

    let build_tx = |seq: i64, fee: i64, data: SorobanTransactionData| Transaction {
        source_account: MuxedAccount::from(source.clone()),
        fee: fee as u32,
        seq_num: SequenceNumber(seq),
        cond: Preconditions::None,
        memo: Memo::None,
        operations: vec![op.clone()].try_into().unwrap(),
        ext: TransactionExt::V1(data),
    };

    let empty_data = SorobanTransactionData {
        ext: ExtensionPoint::V0,
        resources: SorobanResources {
            footprint: LedgerFootprint {
                read_only: VecM::try_from(Vec::new()).unwrap(),
                read_write: VecM::try_from(Vec::new()).unwrap(),
            },
            instructions: 0,
            read_bytes: 0,
            write_bytes: 0,
        },
        resource_fee: 0,
    };

    let client = RpcClient::new(&rpc_url)?;

    // Phase 1: simulate (authoritative footprint + resource fees).
    let sim_env = TransactionEnvelope::Tx(TransactionV1Envelope {
        tx: build_tx(tx_seq, BASE_FEE_STROOPS, empty_data),
        signatures: VecM::default(),
    });
    let sim = client.simulate_transaction_envelope(&sim_env).await?;
    if let Some(err) = &sim.error {
        return Err(format!("simulation failed: {err}").into());
    }
    let mut data: SorobanTransactionData = sim.transaction_data()?;
    // Headroom so validators never reject on instruction-budget margin.
    data.resources.instructions += 100_000;
    let resource_fee: i64 = data.resource_fee.try_into()?;
    println!(
        "{{\"simulated\":\"instructions={} resource_fee={resource_fee}stroops\"}}",
        data.resources.instructions
    );
    let send_tx = build_tx(tx_seq, BASE_FEE_STROOPS + resource_fee, data);

    // Phase 2: sign — sha256(network_id || ENVELOPE_TYPE_TX || tx_xdr)
    // (TransactionSignaturePayload per stellar-core XDR spec).
    let network_id = Sha256::digest(NETWORK_PASSPHRASE.as_bytes());
    let mut preimage = Vec::with_capacity(36 + 512);
    preimage.extend_from_slice(&network_id);
    preimage.extend_from_slice(&ENVELOPE_TYPE_TX.to_be_bytes());
    {
        let mut lim = Limited::new(&mut preimage, Limits::none());
        send_tx.write_xdr(&mut lim)?;
    }
    let sig: Signature = signing.sign(Sha256::digest(&preimage).as_slice());
    let decorated = DecoratedSignature {
        hint: SignatureHint(pub_bytes[28..].try_into()?),
        signature: XdrSignature(sig.to_bytes().try_into().unwrap()),
    };
    let envelope = TransactionEnvelope::Tx(TransactionV1Envelope {
        tx: send_tx,
        signatures: vec![decorated].try_into()?,
    });

    println!(
        "{{\"envelope_xdr_b64\":\"{}\"}}",
        envelope.to_xdr_base64(Limits::none())?
    );

    // Phase 3: send, then best-effort poll to a definitive on-chain status.
    // The RPC-returned hash is authoritative; polling can fail client-side
    // when the ledger's meta XDR version is newer than this SDK's parser
    // (e.g. TransactionMeta V4 vs a 22.x reader) — never mask a send failure,
    // but never fabricate a status either.
    let hash: Hash = client.send_transaction(&envelope).await?;
    println!("{{\"tx_hash\":\"{}\"}}", hex::encode(hash.0));
    println!("{{\"send_status\":\"PENDING\"}}");
    match client
        .get_transaction_polling(&hash, Some(std::time::Duration::from_secs(60)))
        .await
    {
        Ok(resp) => {
            println!("{{\"tx_status\":\"{}\"}}", resp.status);
            if let Ok(rv) = resp.return_value() {
                println!(
                    "{{\"return_value\":\"{}\"}}",
                    rv.to_xdr_base64(Limits::none())?
                );
            }
        }
        Err(e) => {
            println!("{{\"tx_status\":\"SENT_POLL_UNAVAILABLE\",\"poll_error\":\"{e}\"}}");
        }
    }
    Ok(())
}

/// strkey S… → raw 32-byte Ed25519 seed (base32, version + 2-byte CRC stripped).
fn strkey_seed(s: &str) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bits = 0u32;
    let mut acc = 0u32;
    let mut bytes = Vec::new();
    for c in s.bytes() {
        let val = ALPHABET
            .iter()
            .position(|&a| a == c)
            .ok_or("invalid strkey char")? as u32;
        acc = (acc << 5) | val;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    if bytes.len() < 35 {
        return Err("strkey too short".into());
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&bytes[1..33]);
    Ok(seed)
}

/// Minimal JSON extraction for the por-attestor quorum stage (no serde dep).
fn parse_quorum(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = raw.as_bytes();
    while let Some(i) = find(rest, b"\"public_key\":\"") {
        let after = &rest[i + 14..];
        let end = find(after, b"\"").unwrap_or(after.len());
        let pk = String::from_utf8_lossy(&after[..end]).to_string();
        let mut cursor = &after[end..];
        let j = find(cursor, b"\"signature\":\"").map(|x| x + 13).unwrap_or(0);
        cursor = &cursor[j..];
        let end2 = find(cursor, b"\"").unwrap_or(cursor.len());
        let sig = String::from_utf8_lossy(&cursor[..end2]).to_string();
        out.push((pk, sig));
        rest = &cursor[end2..];
    }
    out
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}
