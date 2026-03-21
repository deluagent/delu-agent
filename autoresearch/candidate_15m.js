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
  const rs6=relStr(prices,btcPrices||prices,6);
  const rs18=relStr(prices,btcPrices||prices,18);
  const sma12=sma(prices,12);
  const sma36=sma(prices,Math.min(36,prices.length));
  
  // Bollinger Band width compression
  const bbLen=20;
  const bbWidthHist=[];
  for(let i=Math.max(0,prices.length-50);i<prices.length;i++){
    const window=prices.slice(Math.max(0,i-bbLen+1),i+1);
    const m=window.reduce((s,p)=>s+p,0)/window.length;
    const s=Math.sqrt(window.reduce((sum,p)=>sum+(p-m)*(p-m),0)/window.length);
    bbWidthHist.push(s*2);
  }
  const bbWidth=bbWidthHist[bbWidthHist.length-1];
  const bbWidthPercentile=bbWidthHist.filter(w=>w<bbWidth).length/bbWidthHist.length;
  
  // Volume gate
  const volNow=volumes?volumes.slice(-3).reduce((s,v)=>s+v,0)/3:1;
  const volBase=volumes?volumes.slice(-24).reduce((s,v)=>s+v,0)/24:1;
  const volOk=volNow>=volBase*0.8;
  
  // Ensemble voting: pure majority rule
  const signals=[];
  
  if(rsi8<30)signals.push(1);
  if(rsi8>70)signals.push(-1);
  
  const rsBlended=rs6*0.6+rs18*0.4;
  if(rsBlended>0.05)signals.push(1);
  if(rsBlended<-0.05)signals.push(-1);
  
  if(bbWidthPercentile<0.25)signals.push(1);
  
  if(sma12>sma36)signals.push(1);
  if(sma12<sma36)signals.push(-1);
  
  let ensembleScore=0;
  if(signals.length>0&&volOk){
    const sum=signals.reduce((s,sig)=>s+sig,0);
    ensembleScore=sum>signals.length/2?1:(sum<-signals.length/2?-1:0);
  }
  
  return ensembleScore;
}
module.exports = { scoreToken };