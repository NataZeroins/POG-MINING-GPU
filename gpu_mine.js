require('dotenv').config();
const { ethers } = require('ethers');
const { spawnSync } = require('child_process');
const fs = require('fs');

const CONTRACT='0x214748fC525C1b001e5d4EeB16A3F0b7eaB042B3';
const ABI=[
 'function mine(uint256 nonce) external',
 'function challengeFor(address miner) view returns (bytes32)',
 'function currentDifficulty() view returns (uint256)',
 'function currentEpoch() view returns (uint256)',
 'function currentReward() view returns (uint256)',
 'function totalMints() view returns (uint256)',
 'function totalMined() view returns (uint256)',
 'function miningRemaining() view returns (uint256)'
];
const RPC_URL=process.env.RPC_URL;
const PRIVATE_KEY=process.env.PRIVATE_KEY;
const SUBMIT=process.env.SUBMIT !== 'false';
const BATCH=process.env.BATCH || '4294967296';
const MAX_FEE_USD = Number(process.env.MAX_FEE_USD || '0.09');
const ETH_USD = Number(process.env.ETH_USD || '2192');
const FIXED_MAX_FEE_GWEI = process.env.FIXED_MAX_FEE_GWEI || '';
const FIXED_PRIORITY_GWEI = process.env.FIXED_PRIORITY_GWEI || '';
const STATS_FILE = process.env.STATS_FILE || './stats.json';
function loadStats(){ try{return JSON.parse(fs.readFileSync(STATS_FILE,'utf8'))}catch(e){return {startedAt:new Date().toISOString(),success:0,failed:0,invalid:0,submitted:0,skippedFee:0,lastHashrate:0,lastTx:null,lastError:null,lastUpdate:null}} }
function saveStats(st){ st.lastUpdate=new Date().toISOString(); if(st.lastHashrate) st.lastHashrateHuman=humanHashrate(st.lastHashrate); fs.writeFileSync(STATS_FILE, JSON.stringify(st,null,2)); }

function humanHashrate(h){
 h = Number(h || 0);
 if (h >= 1e12) return (h/1e12).toFixed(2)+' TH/s';
 if (h >= 1e9) return (h/1e9).toFixed(2)+' GH/s';
 if (h >= 1e6) return (h/1e6).toFixed(2)+' MH/s';
 if (h >= 1e3) return (h/1e3).toFixed(2)+' KH/s';
 return Math.round(h)+' H/s';
}
let stats=loadStats(); saveStats(stats);
if(!RPC_URL||!PRIVATE_KEY){ console.error('Need RPC_URL and PRIVATE_KEY'); process.exit(1); }
const provider=new ethers.providers.JsonRpcProvider(RPC_URL, {name:'homestead', chainId:1});
const wallet=new ethers.Wallet(PRIVATE_KEY, provider);
const pog=new ethers.Contract(CONTRACT, ABI, wallet);
function fmt(x){return ethers.utils.formatUnits(x,18)}
async function main(){
 let start = BigInt(process.env.START || Math.floor(Math.random()*1e9));
 while(true){
  const [block,challenge,diff,epoch,reward,totalMints,totalMined,remaining]=await Promise.all([
   provider.getBlockNumber(), pog.challengeFor(wallet.address), pog.currentDifficulty(), pog.currentEpoch(), pog.currentReward(), pog.totalMints(), pog.totalMined(), pog.miningRemaining()
  ]);
  console.log(`wallet ${wallet.address}`);
  console.log(`block ${block} epoch ${epoch.toString()} diff ${diff.toString()}`);
  console.log(`reward ${fmt(reward)} POG | totalMints ${totalMints.toString()} | mined ${fmt(totalMined)} | remaining ${fmt(remaining)}`);
  console.log(`GPU search start=${start} batch=${BATCH}`);
  const r=spawnSync('./pog_cuda_miner',[challenge, diff.toHexString(), start.toString(), BATCH],{cwd:__dirname,encoding:'utf8',stdio:['ignore','pipe','inherit']});
  const out=(r.stdout||'').trim();
  console.log(out);
  const hm=out.match(/hashrate=([0-9.]+) H\/s/); if(hm){ stats.lastHashrate=Number(hm[1]); saveStats(stats); }
  const m=out.match(/FOUND nonce=(\d+)/);
  if(!m){ start += BigInt(BATCH); continue; }
  const nonce=m[1];
  const encoded = ethers.utils.defaultAbiCoder.encode(['bytes32','uint256'], [challenge, nonce]);
  const jsSolution = ethers.utils.keccak256(encoded);
  if (ethers.BigNumber.from(jsSolution).gte(diff)) {
   console.log(`GPU false-positive rejected by JS check nonce=${nonce} solution=${jsSolution}`);
   stats.invalid++; stats.lastError='gpu_false_positive'; saveStats(stats);
   start = BigInt(nonce) + 1n;
   continue;
  }
  console.log(`JS verified nonce=${nonce} solution=${jsSolution}`);
  const latestEpoch=await pog.currentEpoch();
  if(!latestEpoch.eq(epoch)){ console.log(`epoch changed ${epoch}->${latestEpoch}, restart`); continue; }
  if(!SUBMIT){ console.log('SUBMIT=false not sending tx'); return; }
  try{
   const gas=await provider.getFeeData();
   const gasLimit = ethers.BigNumber.from('130000');
   const maxFee = FIXED_MAX_FEE_GWEI ? ethers.utils.parseUnits(FIXED_MAX_FEE_GWEI, 'gwei') : (gas.maxFeePerGas || gas.gasPrice);
   const priorityFee = FIXED_PRIORITY_GWEI ? ethers.utils.parseUnits(FIXED_PRIORITY_GWEI, 'gwei') : gas.maxPriorityFeePerGas;
   const maxCostEth = Number(ethers.utils.formatEther(maxFee.mul(gasLimit)));
   const maxCostUsd = maxCostEth * ETH_USD;
   console.log(`fee check maxFee=${ethers.utils.formatUnits(maxFee,'gwei')} gwei priority=${priorityFee ? ethers.utils.formatUnits(priorityFee,'gwei') : 'auto'} gwei maxCost=$${maxCostUsd.toFixed(4)} cap=$${MAX_FEE_USD}`);
   if(maxCostUsd > MAX_FEE_USD){
    console.log('fee cap exceeded, skip submit and retry later');
    stats.skippedFee++; stats.lastError=`fee_cap_$${maxCostUsd.toFixed(4)}`; saveStats(stats);
    await new Promise(r=>setTimeout(r, 12000));
    continue;
   }
   const tx=await pog.mine(nonce,{gasLimit, maxFeePerGas:maxFee, maxPriorityFeePerGas:priorityFee});
   stats.submitted++; stats.lastTx=tx.hash; saveStats(stats);
   console.log('submitted',tx.hash);
   const rc=await tx.wait();
   if(rc.status === 1){ stats.success++; console.log('confirmed block',rc.blockNumber,'gasUsed',rc.gasUsed.toString()); }
   else { stats.failed++; stats.lastError='receipt_status_0'; console.log('tx failed block',rc.blockNumber,'gasUsed',rc.gasUsed.toString()); }
   saveStats(stats);
  }catch(e){ stats.failed++; stats.lastError=e.reason||e.message; saveStats(stats); console.error('submit failed', e.reason||e.message); }
  start = BigInt(Math.floor(Math.random()*1e9));
 }
}
main().catch(e=>{console.error(e);process.exit(1)});
