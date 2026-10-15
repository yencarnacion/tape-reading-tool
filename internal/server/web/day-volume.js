const etDay = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});

// A daily counter and the sum of available minute candles are different metrics.
// Historical replay must never inherit a present-day feed counter.
export function providerDayVolume(quote, mode, clockUS) {
 const nowMS = clockUS / 1000, stamp = Number(quote?.day_volume_ms), volume = quote?.day_volume;
 if (!['live','massive'].includes(mode) || !Number.isFinite(nowMS) || nowMS <= 0 ||
     !Number.isFinite(stamp) || stamp <= 0 || !Number.isFinite(volume) || volume < 0 ||
     stamp > nowMS + 2000 || nowMS - stamp > 90000 || etDay.format(stamp) !== etDay.format(nowMS)) return null;
 return volume;
}
