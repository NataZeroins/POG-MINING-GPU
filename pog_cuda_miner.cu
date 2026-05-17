#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <chrono>
#include <cuda_runtime.h>

__device__ __host__ static inline uint64_t rol64(uint64_t x, int s){ return (x << s) | (x >> (64 - s)); }

__device__ __host__ void keccakf(uint64_t st[25]){
 static const uint64_t rndc[24] = {
  0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
  0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
  0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
  0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
  0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
  0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL};
 static const int rotc[24] = {1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44};
 static const int piln[24] = {10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1};
 uint64_t bc[5], t;
 for(int round=0; round<24; round++){
  for(int i=0;i<5;i++) bc[i]=st[i]^st[i+5]^st[i+10]^st[i+15]^st[i+20];
  for(int i=0;i<5;i++){ t=bc[(i+4)%5]^rol64(bc[(i+1)%5],1); for(int j=0;j<25;j+=5) st[j+i]^=t; }
  t=st[1];
  for(int i=0;i<24;i++){ int j=piln[i]; bc[0]=st[j]; st[j]=rol64(t,rotc[i]); t=bc[0]; }
  for(int j=0;j<25;j+=5){ for(int i=0;i<5;i++) bc[i]=st[j+i]; for(int i=0;i<5;i++) st[j+i]^=(~bc[(i+1)%5])&bc[(i+2)%5]; }
  st[0]^=rndc[round];
 }
}

__device__ __host__ void keccak256_64(const uint8_t in[64], uint8_t out[32]){
 uint64_t st[25];
 for(int i=0;i<25;i++) st[i]=0;
 for(int i=0;i<64;i++) ((uint8_t*)st)[i]^=in[i];
 ((uint8_t*)st)[64]^=0x01;      // Keccak pad10*1, not SHA3 0x06
 ((uint8_t*)st)[135]^=0x80;     // rate=136 bytes for keccak256
 keccakf(st);
 for(int i=0;i<32;i++) out[i]=((uint8_t*)st)[i];
}

__device__ bool lt_be(const uint8_t h[32], const uint8_t target[32]){
 for(int i=0;i<32;i++){ if(h[i]<target[i]) return true; if(h[i]>target[i]) return false; }
 return false;
}

__global__ void search(uint8_t *challenge, uint8_t *target, unsigned long long start, unsigned long long count, unsigned long long *found, int *flag){
 unsigned long long idx=blockIdx.x*(unsigned long long)blockDim.x+threadIdx.x;
 unsigned long long stride=gridDim.x*(unsigned long long)blockDim.x;
 uint8_t buf[64], out[32];
 for(int i=0;i<32;i++) buf[i]=challenge[i];
 for(unsigned long long n=start+idx; n<start+count; n+=stride){
  if(atomicAdd(flag,0)) return;
  for(int i=32;i<64;i++) buf[i]=0;
  unsigned long long x=n;
  for(int i=0;i<8;i++){ buf[63-i]=(uint8_t)(x&0xff); x>>=8; }
  keccak256_64(buf,out);
  if(lt_be(out,target)){ *found=n; atomicExch(flag,1); return; }
 }
}

int hexval(char c){ if(c>='0'&&c<='9')return c-'0'; if(c>='a'&&c<='f')return c-'a'+10; if(c>='A'&&c<='F')return c-'A'+10; return 0; }
void parsehex(const char* s,uint8_t out[32]){
 if(s[0]=='0'&&s[1]=='x')s+=2;
 int len=strlen(s); memset(out,0,32); int nib=64-len;
 for(int i=0;i<len;i++){ int p=nib+i; if(p<0||p>=64) continue; if((p&1)==0) out[p/2]|=(uint8_t)(hexval(s[i])<<4); else out[p/2]|=(uint8_t)hexval(s[i]); }
}
void printhex(const uint8_t *x,int n){ for(int i=0;i<n;i++) printf("%02x",x[i]); printf("\n"); }

int main(int argc,char**argv){
 if(argc<5){ fprintf(stderr,"usage: %s challenge targetHex start count [--hash nonce]\n",argv[0]); return 2; }
 uint8_t h_chal[32], h_tgt[32]; parsehex(argv[1],h_chal); parsehex(argv[2],h_tgt);
 unsigned long long start=strtoull(argv[3],0,10), count=strtoull(argv[4],0,10);
 if(argc>=7 && strcmp(argv[5],"--hash")==0){
  uint8_t buf[64], out[32]; memcpy(buf,h_chal,32); memset(buf+32,0,32); unsigned long long x=strtoull(argv[6],0,10); for(int i=0;i<8;i++){ buf[63-i]=(uint8_t)(x&0xff); x>>=8; }
  keccak256_64(buf,out); printf("HASH 0x"); printhex(out,32); return 0;
 }
 uint8_t *d_chal,*d_tgt; unsigned long long *d_found,h_found=0; int *d_flag,h_flag=0;
 cudaMalloc(&d_chal,32); cudaMalloc(&d_tgt,32); cudaMalloc(&d_found,8); cudaMalloc(&d_flag,4);
 cudaMemcpy(d_chal,h_chal,32,cudaMemcpyHostToDevice); cudaMemcpy(d_tgt,h_tgt,32,cudaMemcpyHostToDevice); cudaMemset(d_flag,0,4); cudaMemset(d_found,0,8);
 int blocks=4096, threads=256; auto t0=std::chrono::high_resolution_clock::now();
 search<<<blocks,threads>>>(d_chal,d_tgt,start,count,d_found,d_flag); cudaDeviceSynchronize();
 auto t1=std::chrono::high_resolution_clock::now(); double sec=std::chrono::duration<double>(t1-t0).count();
 cudaMemcpy(&h_flag,d_flag,4,cudaMemcpyDeviceToHost); cudaMemcpy(&h_found,d_found,8,cudaMemcpyDeviceToHost);
 double hs=count/sec; printf("scanned=%llu seconds=%.3f hashrate=%.0f H/s\n",count,sec,hs);
 if(h_flag) printf("FOUND nonce=%llu\n",h_found); else printf("NOT_FOUND\n");
 return 0;
}
