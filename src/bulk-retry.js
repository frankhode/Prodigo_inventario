// Reintentos acotados para transferencias grandes: nunca reintentar a ciegas
// una operación que puede consumir correlativos.
export function retryableTransferError(error) {
  const code=Number(error?.status ?? error?.statusCode ?? 0);
  if([408,425,429,500,502,503,504,520,521,522,523,524].includes(code))return true;
  const message=String(error?.message||'');
  return /(?:HTTP\s*(?:408|425|429|500|502|503|504|520|521|522|523|524)\b|network error|failed to fetch|load failed|network request failed|timed out)/i.test(message);
}

export async function retryBulkTransfer(operation,{attempts=3,onRetry=null,wait=null}={}) {
  if(!Number.isInteger(attempts)||attempts<1||attempts>5)throw Error('Cantidad de intentos inválida.');
  const pause=wait||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));
  for(let attempt=1;attempt<=attempts;attempt++){
    try {return await operation();}
    catch(error){
      if(attempt===attempts||!retryableTransferError(error))throw error;
      onRetry?.(attempt,error);
      await pause(650*(2**(attempt-1)));
    }
  }
}
