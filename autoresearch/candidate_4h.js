'use strict';
function sma(prices, period) { const n=Math.min(period,prices.length); return prices.slice(-n).reduce((s,p)=>s+p,0)/n; }
function rsi(prices, period) {
  if (prices.length < period+1) return 50;
  let g=0,l=0; const st=prices.length-period;
  for (let i=st;i<prices.length;i++){const d=prices[i]-prices[i-1];if(d>0)g+=d;else l-=d;}
  if(l===0)return 100; return 100-100/(1+(g/period)/(l/period));
}
function relStr(prices, btc, period) {
  if(prices.length<period||btc.length<period)return 0;
  const tr=(prices[prices.length-1]-prices[prices.length-period])/prices[prices.length-period];
  const br=(btc[btc.length-1]-btc[btc.length-period])/btc[btc.length-period];
  return tr-br;
}
function scoreToken(data) {
  const {prices,volumes,btcPrices}=data;
  if(!prices||prices.length<50)return 0;
  
  const rsi8=rsi(prices,8);
  const len=prices.length;
  
  const mid=sma(prices,20);
  const stdDev=Math.sqrt(prices.slice(-20).reduce((sum,p,i)=>{
    const diff=p-mid[len-20+i];
    return sum+diff*diff;
  },0)/20);
  const bbUpper=mid[len-1]+2*stdDev;
  const bbLower=mid[len-1]-2*stdDev;
  const bbWidth=bbUpper-bbLower;
  
  let bbWidthHist=[];
  for(let i=Math.max(0,len-30);i<len;i++){
    const start=Math.max(0,i-19);
    const windowPrices=prices.slice(start,i+1);
    const m=windowPrices.reduce((sum,p)=>sum+p,0)/windowPrices.length;
    const s=Math.sqrt(windowPrices.reduce((sum,p)=>sum+(p-m)*(p-m),0)/windowPrices.length);
    bbWidthHist.push((m+2*s)-(m-2*s));
  }
  const bbWidthSMA=sma(bbWidthHist,10);
  const bbCompressionRatio=bbWidth/bbWidthSMA[bbWidthSMA.length-1];
  const bbCompression=bbCompressionRatio<0.35?1:0;
  
  const rsiOversold=rsi8<30?1:0;
  const rsiOverbought=rsi8>70?-1:0;
  const rsiMomentum=rsi8>55?0.5:(rsi8<45?-0.5:0);
  
  const votes=[
    rsiOversold,
    bbCompression,
    rsiOverbought
  ];
  
  const voteSum=votes.reduce((a,b)=>a+b,0);
  const ensembleSignal=voteSum>=2?1:(voteSum<=-1?-1:0);
  
  return Math.max(-1,Math.min(1,ensembleSignal+rsiMomentum*0.2));
}
module.exports={scoreToken};