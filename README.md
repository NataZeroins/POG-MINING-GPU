# POG GPU Miner

CUDA GPU miner for **POG / Generation Token**.

Contract: `0x214748fC525C1b001e5d4EeB16A3F0b7eaB042B3`

This miner:

- reads the current POG mining challenge from Ethereum mainnet,
- searches valid nonces on an NVIDIA GPU,
- verifies the GPU result again in JavaScript before submit,
- submits `mine(uint256 nonce)` when gas is below your configured cap,
- writes live counters to `stats.json`.

## Safety

Use a **burner wallet only**. Do not use your main wallet.

Never commit `.env`, private keys, RPC URLs, logs, or `stats.json`.

## Requirements

- Linux server with NVIDIA GPU
- NVIDIA driver
- CUDA toolkit with `nvcc`
- Node.js + npm
- Ethereum mainnet RPC URL, e.g. Alchemy/Infura
- Burner wallet with small ETH balance for gas

Check GPU/CUDA:

```bash
nvidia-smi
nvcc --version
node -v
npm -v
```

## Quick start

```bash
git clone https://github.com/NataZeroins/POG-MINING-GPU.git
cd POG-GPU-MINING
npm install
cp .env.example .env
nano .env
```

Build CUDA miner:

```bash
nvcc -O3 -arch=sm_86 pog_cuda_miner.cu -o pog_cuda_miner
```

Run miner:

```bash
npm run mine
```

Or:

```bash
./start.sh
```

## GPU architecture

The example build uses:

```bash
-arch=sm_86
```

That works for RTX 30xx / A4000 Ampere-class GPUs.

For other GPUs, change the arch flag:

- RTX 20xx / Turing: `sm_75`
- RTX 30xx / Ampere: `sm_86`
- RTX 40xx / Ada: `sm_89`
- H100 / Hopper: `sm_90`

Example for RTX 4090:

```bash
nvcc -O3 -arch=sm_89 pog_cuda_miner.cu -o pog_cuda_miner
```

## `.env` config

Create `.env` from `.env.example`:

```env
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0xYOUR_BURNER_PRIVATE_KEY

MAX_FEE_USD=0.08
ETH_USD=2192

FIXED_MAX_FEE_GWEI=0.26
FIXED_PRIORITY_GWEI=0.229875685

BATCH=4294967296
STATS_FILE=./stats.json
```

Important fields:

- `RPC_URL` — Ethereum mainnet RPC.
- `PRIVATE_KEY` — burner wallet private key.
- `MAX_FEE_USD` — max estimated USD cost per submitted mine tx.
- `ETH_USD` — ETH price estimate used for the USD cap calculation.
- `FIXED_MAX_FEE_GWEI` — EIP-1559 `maxFeePerGas`.
- `FIXED_PRIORITY_GWEI` — EIP-1559 `maxPriorityFeePerGas`.
- `BATCH` — GPU nonce search range per CUDA run.
- `STATS_FILE` — where runtime stats are written.

If estimated tx cost is above `MAX_FEE_USD`, the script skips submit and keeps mining/checking.

## Run in background

```bash
nohup env $(cat .env | xargs) node gpu_mine.js > mine.log 2>&1 < /dev/null & echo $! > mine.pid
```

Check logs:

```bash
tail -f mine.log
```

Check stats:

```bash
cat stats.json
```

Stop:

```bash
kill $(cat mine.pid)
# or
pkill -f 'node gpu_mine.js'
```

## Stats output

`stats.json` includes counters like:

```json
{
  "success": 0,
  "failed": 0,
  "invalid": 0,
  "submitted": 0,
  "skippedFee": 0,
  "lastHashrateHuman": "83.47 GH/s",
  "lastTx": "0x...",
  "lastError": null
}
```

Meanings:

- `submitted` — tx was sent.
- `success` — tx confirmed successfully.
- `failed` — tx submit/receipt failed.
- `invalid` — GPU result failed JS verification and was not submitted.
- `skippedFee` — valid nonce found, but tx was skipped due to fee cap.
- `lastHashrateHuman` — latest GPU scan rate in GH/s or MH/s.

## Notes

- The CUDA result is verified with `ethers.keccak256(abi.encode(challenge, nonce))` before submitting.
- Solutions are epoch-bound. A nonce can expire if the epoch changes before submit.
- Low gas settings can cause stale/failed transactions during heavy competition.
- Keep ETH balance topped up; no ETH means valid solutions cannot be submitted.

## Files

- `pog_cuda_miner.cu` — CUDA nonce searcher.
- `gpu_mine.js` — contract state reader, JS verifier, tx submitter, stats writer.
- `.env.example` — config template.
- `start.sh` — simple foreground launcher.
