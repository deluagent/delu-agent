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
  const sma12=sma(prices,12);
  const sma36=sma(prices,Math.min(36,prices.length));
  
  const len=prices.length;
  const mid=sma(prices,20);
  const stdDev=Math.sqrt(prices.slice(-20).reduce((sum,p,i)=>{
    const diff=p-mid[len-20+i];
    return sum+diff*diff;
  },0)/20);
  const bbUpper=mid[len-1]+2*stdDev;
  const bbLower=mid[len-1]-2*stdDev;
  const bbWidth=bbUpper-bbLower;
  
  const bbWidthSMA=sma(prices.slice(-30).map(p=>{
    const m=sma(prices.slice(0,prices.indexOf(p)+1),20)[prices.indexOf(p)];
    const s=Math.sqrt(prices.slice(Math.max(0,prices.indexOf(p)-19),prices.indexOf(p)+1).reduce((sum,px)=>{
      return sum+(px-m)*(px-m);
    },0)/20);
    return m+2*s-(m-2*s);
  }),10);
  const bbCompression=bbWidth<bbWidthSMA[bbWidthSMA.length-1]*0.5?1:-0.5;
  
  const volNow=volumes?volumes.slice(-3).reduce((s,v)=>s+v,0)/3:1;
  const volBase=volumes?volumes.slice(-24).reduce((s,v)=>s+v,0)/24:1;
  const volR=volBase>0?volNow/volBase:1;
  const volConfirm=volR>1.2?1:-0.3;
  
  const rsiOversold=rsi8<30?1:-0.4;
  const rsiOverbought=rsi8>70?-1:0.4;
  const rsiSignal=rsiOversold+rsiOverbought;
  
  const trendSignal=(sma12>sma36)?1:-1;
  
  const votes=[
    rsiSignal>0.2?1:0,
    bbCompression>0?1:0,
    volConfirm>0?1:0,
    trendSignal>0?1:0
  ];
  
  const voteSum=votes.reduce((a,b)=>a+b,0);
  const ensembleSignal=voteSum>=2?1:(voteSum===0?-1:0);
  
  return Math.max(-1,Math.min(1,ensembleSignal*0.8+bbCompression*0.15+rsiSignal*0.05));
}
module.exports={scoreToken};