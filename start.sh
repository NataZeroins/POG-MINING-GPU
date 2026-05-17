#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x ./pog_cuda_miner ]; then
  echo "Missing ./pog_cuda_miner. Build it first:"
  echo "nvcc -O3 -arch=sm_86 pog_cuda_miner.cu -o pog_cuda_miner"
  exit 1
fi
exec npm run mine
