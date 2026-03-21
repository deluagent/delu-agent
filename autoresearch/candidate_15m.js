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
// DESCRIPTION: Lower RSI thresholds to 35/65 to catch earlier signals on 15m bars, matching intraday sensitivity
function scoreToken(data) {
  const {prices,volumes,btcPrices}=data;
  if(!prices||prices.length<50)return 0;
  
  const rsi8=rsi(prices,8);
  const rsi8Prev=rsi(prices.slice(0,-1),8);
  const sma12=sma(prices,12);
  const sma36=sma(prices,Math.min(36,prices.length));
  
  // Bollinger Band width compression detection - tighter threshold
  const closes=prices.slice(-20);
  const mean=closes.reduce((s,p)=>s+p,0)/closes.length;
  const stdDev=Math.sqrt(closes.reduce((s,p)=>s+Math.pow(p-mean,2),0)/closes.length);
  const bbWidth=stdDev*2;
  const bbWidthPercentile=bbWidth/(mean*0.05);
  const isCompressed=bbWidthPercentile<0.2;
  
  // Volume gate
  const volNow=volumes?volumes.slice(-3).reduce((s,v)=>s+v,0)/3:1;
  const volBase=volumes?volumes.slice(-24).reduce((s,v)=>s+v,0)/24:1;
  const volOk=volNow>=volBase*0.7;
  
  // Ensemble voting with RSI momentum confirmation
  const signals=[];
  
  // BB compression + RSI alignment (RSI moving in signal direction)
  if(isCompressed&&rsi8<25&&rsi8<rsi8Prev){
    signals.push(1);
  }
  if(isCompressed&&rsi8>75&&rsi8>rsi8Prev){
    signals.push(-1);
  }
  
  // SMA trend signal
  if(sma12>sma36){
    signals.push(1);
  }
  if(sma12<sma36){
    signals.push(-1);
  }
  
  let ensembleScore=0;
  if(signals.length>=2&&volOk){
    const longCount=signals.filter(s=>s===1).length;
    const shortCount=signals.filter(s=>s===-1).length;
    if(longCount>=2)ensembleScore=1;
    else if(shortCount>=2)ensembleScore=-1;
  }
  
  return ensembleScore;
}
module.exports = { scoreToken };