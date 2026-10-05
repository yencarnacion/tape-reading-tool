# Reading the ADR + Options Vol panel: a scalper’s teaching guide

**Prepared:** October 5, 2026.

**Implementation reviewed:** Tape Reading Tool commit `9ac3be4`.

**Reference image:** the supplied STX screenshot, with the replay clock at **09:31:54 ET**. The accompanying session context identifies the replay as Friday, October 2, 2026; the screenshot itself does not display that session date.

**Audience:** a stock daytrading scalper, and a teacher or NotebookLM video explaining the screen.

This guide describes the implemented panel, including its missing-data behavior. It distinguishes screenshot observations, code-defined calculations, and hypothetical teaching examples. The examples illustrate interpretation; they are not evidence of a profitable strategy or a reconstruction of what STX did next.

The screenshot should be supplied separately to the video author. This public document contains no private service configuration, credentials, recording locations, or companion-application implementation.

## Contents

1. [What the panel is for](#1-what-the-panel-is-for)
2. [Read the supplied STX screenshot](#2-read-the-supplied-stx-screenshot)
3. [The options background you actually need](#3-the-options-background-you-actually-need)
4. [ADR and the running RTH low/high](#4-adr-and-the-running-rth-lowhigh)
5. [ATM IV and quote quality](#5-atm-iv-and-quote-quality)
6. [IV impulse and the headline](#6-iv-impulse-and-the-headline)
7. [IV move used](#7-iv-move-used)
8. [Off IV peak](#8-off-iv-peak)
9. [Actual pace: realized versus implied volatility](#9-actual-pace-realized-versus-implied-volatility)
10. [Put fear: the skew measurement](#10-put-fear-the-skew-measurement)
11. [Buy flow and sell flow](#11-buy-flow-and-sell-flow)
12. [Divergence and exhaustion rules](#12-divergence-and-exhaustion-rules)
13. [Volume delta, RVOL, and Kronos](#13-volume-delta-rvol-and-kronos)
14. [A practical reading routine and worked scenarios](#14-a-practical-reading-routine-and-worked-scenarios)
15. [Replay, missing data, and warm-up](#15-replay-missing-data-and-warm-up)
16. [Code and numerical exercises](#16-code-and-numerical-exercises)
17. [A teaching-video storyboard](#17-a-teaching-video-storyboard)
18. [Review questions and a replay worksheet](#18-review-questions-and-a-replay-worksheet)
19. [What is implemented and what is not](#19-what-is-implemented-and-what-is-not)
20. [Source map and further reading](#20-source-map-and-further-reading)

## 1. What the panel is for

The panel places **stock movement, option-implied uncertainty, and classified stock flow** beside one another. Its useful question is:

> As the stock stretches, are options pricing more uncertainty, and is the previously dominant stock flow accelerating or slowing?

It is context for interpreting price and tape. It does not select an entry, calculate a stop, prove absorption, or place an order. Its thresholds are descriptive research rules, not calibrated reversal probabilities.

Read it in this order when time is short:

1. **Quality:** can the options readings be used at all? `OPTIONS WIDE`, stale data, and dashes take priority over a tempting number.
2. **Anchor and stretch:** is ADR measured from the low or high? Where did the IV move reference start?
3. **IV direction:** expanding, cooling, steady, or still building?
4. **Stock flow:** buy or sell flow; faster, slower, or steady?
5. **Price response:** does the chart and current tape support the interpretation being considered?

For the supplied image, the short reading is:

> “STX has rebounded about one-third of an ADR from its running RTH low. Historical option quotes are too wide for IV signals. Previously dominant buy-classified flow is roughly steady. There is no confirmed IV divergence on this screen.”

That statement deliberately stops at what the image supports. It does not infer a bottom, a new short entry, or a completed reversal.

## 2. Read the supplied STX screenshot

### 2.1 The spatial map

The main chart is on the left. Immediately to its right is a vertical stack:

```text
VOLUME DELTA                 Stock prints, aggregated by selected tick size
MODE / LOOKBACK / PANEL      ADR controls and panel selection
ADR FROM RTH LOW/HIGH        Historical range context
OPTIONS STATUS              Quality first; then IV regime when usable
SIX METRIC CARDS             IV, impulse, move used, peak, pace, skew
BUY / SELL FLOW              Classified stock-share flow
DIVERGENCE CHECKS / DETAILS  Evidence and calculation context
KRONOS FORECAST              Separate experimental model output
REPLAY CLOCK                The historical time being evaluated
```

The narrow column on the far right contains **RVOL PACE** and stock time-and-sales. Neither is an options transaction feed. The ADR/options section is expanded; Kronos is compact so volume delta remains readable on a small display.

### 2.2 Translate every important visible reading

| Screenshot reading | Meaning | Do not interpret it as |
|---|---|---|
| `FROM LOW`, lookback `20` | Measure distance above the running regular-session low, using 20 completed sessions for ADR. | A measure of how far the stock has fallen from its high. |
| `0.33 ADR` | The selected extension is about 0.33 times the historical average range percentage. | 33% of a guaranteed daily allowance consumed. |
| `+1.80% FROM RTH LOW` | The relevant stock price is about 1.80% above the running RTH low. | Up 1.80% from the open or prior close. |
| `ADR20 5.39%` | Mean of 20 completed sessions’ `high / low − 1`. | Today’s expected return or a stop distance. |
| `OPTIONS WIDE` | A historical quote-based IV range can be shown, but the point estimate fails the signal-quality requirements. | Options giving a directional signal. |
| `REPLAY · EST.` | Historical option quotes have been used to estimate IV. | An exact recording of the provider’s historical IV and Greeks. |
| `Spreads up to 50%` | The largest relative option spread in the diagnostic ATM basket is about 50% of its midpoint. | The stock’s 93-cent bid–ask spread, or a 50% predicted stock move. |
| `ATM IV 57–86%` | A rounded range between median bid-implied and ask-implied annualized volatility estimates. | A confidence interval, probability, IV rank, or predicted 57–86% stock return. |
| `IV IMPULSE --` | No usable IV-change signal is being published. | Zero change in IV. |
| `IV MOVE USED --` | No reliable move-used value is being published. | Zero movement or unlimited remaining room. |
| `OFF IV PEAK --` | No reliable peak-distance value is being published. | IV sitting exactly at its peak. |
| `ACTUAL PACE BUILDING` | The required completed stock-return history is not yet available. | Quiet price action. A violent opening move can still show BUILDING. |
| `PUT FEAR --` | No usable wing-skew reading is published. | No downside concern in the market. |
| Green `BUY FLOW`, `STEADY`, `−9.4% · 30s` | Previously dominant buy-classified stock-share volume is 9.4% lower in the recent completed 30 seconds than in the preceding 30 seconds. That is inside the steady band. | Call buying, a buy recommendation, or proof buyers now dominate the latest window. |
| Dashes beside the four divergence checks | The panel is not presenting usable confirmation evidence. Wide options suppress these checks. | Four negative tests or a confirmed absence of divergence in the market. |
| `6 quotes · ≤20% spread needed` | Six contract quote records support the wide-range diagnostic; signal calculations need acceptable spreads. | Six option trades, six seconds of history, or a sufficient sample for prediction. |
| Kronos `100% ABOVE`, `14/32 USABLE` | All 14 usable generated paths close above the displayed reference; 18 attempted paths are invalid. | A 100% real-world probability of a profitable long. |

### 2.3 The arithmetic that explains the green ADR reading

The image labels the RTH low **$791.75** and a chart price **$805.97**:

```text
Move from low = (805.97 / 791.75 − 1) × 100 ≈ 1.80%
ADR extension = 1.80% / 5.39% ≈ 0.33 ADR
```

The chart can show a severe selloff and a green FROM LOW number simultaneously. The green number describes the rebound off the low. It does not describe the entire session’s direction.

The header last price is **$806.43**, while the chart label is **$805.97**. A screen capture can contain values updated on different event/render paths. Do not force every displayed field to reconcile to a single atomic tick. The chart price above approximately reproduces the shown ADR reading; it does not prove the exact internal input at capture time.

## 3. The options background you actually need

### 3.1 Calls, puts, strikes, and expiry

A call gives its holder the right to buy the underlying at a specified strike; a put gives the right to sell. Expiration defines the contract’s lifetime. “At the money,” or ATM, means the strike is near the stock price. The holder’s rights and the writer’s obligations are different. This dashboard uses option information to help read the **stock**; it does not require trading options. See the [Options Industry Council’s introduction](https://www.optionseducation.org/optionsoverview/what-is-an-option).

### 3.2 Implied volatility: reverse-engineering a price

An option-pricing model connects the stock price, strike, time remaining, volatility, rates, and dividends to an option value. IV asks: **what volatility input makes that model match the observed option price?** An option becoming more expensive is not automatically an IV increase; the stock may simply have moved. See [OIC: Options Pricing](https://www.optionseducation.org/optionsoverview/options-pricing).

IV is conventionally expressed as an annualized percentage. It concerns variability, not a promised direction. Realized volatility measures movement that has already occurred; implied volatility is inferred from option prices. This distinction is described in [OIC’s technical FAQ](https://www.optionseducation.org/referencelibrary/faq/technical-information).

For this panel, an IV of `30%` is stored as `0.30`. It is not a prediction that the stock will rise 30%, nor a measurement of the probability that it will fall. A daily conversion is an approximation, discussed below.

### 3.3 Option delta versus volume delta

Option delta estimates how much an option’s quoted premium changes for a $1 underlying move, holding other model inputs fixed. A call delta of `+0.25` and a put delta of `−0.25` identify the wings used here. They are model sensitivities, not this panel’s measured odds of a price move. See [OIC: Delta](https://www.optionseducation.org/advancedconcepts/delta).

**Volume delta** above the options panel means something else: classified buy shares minus classified sell shares. Keep these two uses of “delta” separate throughout the video.

### 3.4 Why look across strikes?

Different strikes can carry different IVs: the volatility skew. Comparing put and call wings can describe asymmetric pricing of downside and upside exposure. This is an interpretation of prices, not direct identification of who is buying or why. See [Cboe’s discussion of volatility skew](https://www.cboe.com/insights/posts/inside-volatility-trading-the-adventures-of-volatility-markets).

The panel’s `PUT FEAR` label is shorthand for one particular skew calculation. It is not a psychological measurement, an institutional-positioning detector, or Cboe’s SKEW index.

## 4. ADR and the running RTH low/high

The existing ADR calculation remains intact. RTH means regular trading hours; the panel’s time logic uses **09:30–16:00 America/New_York**. Required session data must reach the RTH open; partial coverage is identified rather than silently treated as complete.

For `N` completed sessions before the current session:

```text
daily range fraction[i] = high[i] / low[i] − 1
ADR fraction = mean(daily range fraction[i], i = 1…N)
ADR displayed percent = 100 × ADR fraction
```

The lookback is bounded to **5–60** sessions, default **20**. This is a mean of percentage ranges, not ATR, not a mean dollar range, and not a high-to-low range divided by the close. Today’s incomplete daily candle is excluded.

With current price `P`, running RTH low `L`, and running RTH high `H`:

| Mode | Extension fraction | Which movement it describes |
|---|---|---|
| FROM LOW | `P / L − 1` | Distance up from the running low. |
| FROM HIGH | `H / P − 1` | Distance down from the running high, using the implementation’s ratio convention. |
| AUTO | FROM LOW when `P >= RTH open`; otherwise FROM HIGH. | A reference selected by price versus the RTH open. |

Both divide that fraction by the ADR fraction to produce the large ADR multiple.

**FROM HIGH is specifically `H / P − 1`, not `(H − P) / H`.** Both express a decline-related distance but have different denominators. A teacher reproducing the numbers should use the implemented formula.

The meter uses **1.25 ADR as its full-width display scale** and clamps visually above that; the numeric reading can continue higher. It is not a countdown to an inevitable reversal. Green FROM LOW and coral FROM HIGH are reference-direction cues; very small extensions stay neutral.

New session extremes move the reference. If a fresh low is printed, the FROM LOW reading can drop sharply even though the day has become more volatile. Keep the mode visible while interpreting changes.

**Interaction with options:** the selected ADR extension is one possible stretch condition for `EXHAUSTION WATCH`. Switching FROM LOW to FROM HIGH can change that condition. It does not change ATM IV, stock-flow classification, or the frozen IV move denominator.

## 5. ATM IV and quote quality

### 5.1 How the live ATM basket is built

The app receives a bounded nearby option chain through an optional local gateway. The live provider snapshot can include IV, Greeks, quotes, and open interest; see the [Massive option-chain snapshot schema](https://massive.com/docs/rest/options/snapshots/option-chain-snapshot). Those available fields do not mean every field becomes a displayed signal.

The implementation searches the first two complete expiry groups encountered within a **45-calendar-day window**, with strikes within **10%** of spot. It then uses the nearest expiry that passes the basket checks:

- Standard 100-share contracts are retained by the live backend.
- Positive bid, ask at least bid, and relative spread at most **20%**.
- Real-time quotes no older than **20 seconds**; live clock tolerance allows at most 2 seconds ahead.
- Live volume at least **10**, or open interest at least **20**.
- Positive finite IV no greater than `10.0` in decimal units, a sanity ceiling of 1000%.
- Calls with delta between **+0.30 and +0.70**; puts between **−0.70 and −0.30**.
- At least **two matching call/put strike pairs**; up to three pairs, giving **4–6 ATM contracts**.
- Every basket IV must lie within **25% relative distance** of the basket’s median IV.

The displayed ATM IV is the **median** of those contract IVs. An existing eligible basket is retained to reduce changes caused merely by switching strikes. If it must change, comparable IV history restarts.

These are engineering filters. They do not prove that a contract is liquid enough for a particular order, that its IV is economically correct, or that an option midpoint is executable. The 100-share check is not a complete analysis of every adjusted deliverable.

### 5.2 What a 50% spread means

```text
midpoint = (bid + ask) / 2
relative option spread = (ask − bid) / midpoint

Hypothetical bid $6, ask $10:
midpoint = $8
relative spread = $4 / $8 = 50%
```

This hypothetical example explains the unit; it is not a claim about the screenshot’s actual option prices.

At wide quotes, a tiny change in which price is used can produce a large difference in inferred IV. A single precise-looking midpoint IV would invite overinterpretation. The replay diagnostic therefore can show the **median bid-IV to median ask-IV range**, while withholding point-estimate signals.

For `57–86%`, do not average the endpoints and treat `71.5%` as an approved signal. The implementation has deliberately rejected that use. Nor is the interval the minimum and maximum IV across all contracts: each endpoint is a median of separately inverted bid or ask prices in the diagnostic ATM basket.

`OPTIONS WIDE` is a replay-estimate behavior. Its diagnostic accepts only bounded, fresh, solvable quotes, with at least four ATM contracts and maximum relative spread above 20% but no greater than 100%. It is not a fallback that validates arbitrarily bad markets.

## 6. IV impulse and the headline

IV impulse is an actual change in volatility points, not a normalized −100 to +100 score:

```text
IV change in points = (IV_now_decimal − IV_then_decimal) × 100

30.0% IV → 31.2% IV:
change = +1.2 volatility points
relative IV increase = 31.2 / 30.0 − 1 = +4.0%
```

Those two numbers answer different questions. `IV IMPULSE · 1m` displays the point change; the smaller row shows **30-second** and **5-minute** changes. All need comparable observations. The older observation must be at or before the target time and no more than 10 seconds earlier than that target.

The ordinary headline uses the one-minute change and this deadband:

```text
threshold in IV points = max(0.2, current IV percent × 0.005)
```

| Condition | Headline |
|---|---|
| No comparable one-minute change | BUILDING IV TREND |
| One-minute change strictly above threshold | VOL EXPANDING |
| One-minute change strictly below negative threshold | VOL COOLING |
| Otherwise, including equality at either boundary | VOL STEADY |

At 30% IV, the threshold is **0.2 points**. At 80% IV, it is **0.4 points**. Orange cues identify expansion; blue cues identify cooling. Purple cues identify the two watch states described later. Color represents the kind of context, not an instruction to buy or sell.

**Scalping interpretation:** expanding IV during a fast selloff is a reason to question an automatic “it has moved far enough” assumption. Cooling IV can be compatible with easing uncertainty, but it does not identify the exact end of a price move. IV can move for reasons other than current directional stock pressure.

The three windows offer short, medium, and longer comparisons of the same measurement. They are not three independent votes or a statistical confidence score.

## 7. IV move used

### 7.1 The frozen reference

On the first accepted options snapshot, the model saves:

```text
S0 = stock price at the first valid options observation
IV0 = ATM IV at that observation, in decimal form
M = S0 × IV0 / sqrt(252)

IV MOVE USED = abs(current stock price − S0) / M × 100
```

`M` is the displayed approximate **one-trading-day dollar projection**. Dividing annualized volatility by roughly 16 is a common daily scaling convention; see [Cboe’s daily-move example](https://www.cboe.com/insights/posts/the-vix-index-and-muted-volatility-in-2022/). This tool uses `sqrt(252)` exactly, as a heuristic applied to its selected front-expiry basket.

The denominator stays frozen when later IV rises. That prevents a larger current IV from making earlier stock displacement appear to disappear.

### 7.2 A worked example

**Hypothetical inputs:** first valid observation at stock `$100`, ATM IV `30%`.

```text
M = 100 × 0.30 / sqrt(252) ≈ $1.8898
Later stock price = $98.30
Displacement = $1.70
Move used ≈ 1.70 / 1.8898 × 100 = 89.96%, displayed about 90%
Direction arrow = down
```

This is displacement from one anchor. If the stock first rises and then returns to `$100`, move used returns to zero even though it traveled a substantial path. It is neither cumulative distance traveled nor today’s high–low range.

### 7.3 What the reference does not mean

- It is not necessarily the **09:30 opening estimate**. First valid options may arrive later.
- It is not a move remaining until the close. The scale is not reduced as the session progresses.
- It is not the move until the selected option expires.
- It is not automatically a 0DTE estimate, even on a Friday.
- It is not a price barrier. Values above 100% are valid.
- It is not a calibrated probability interval; event risk and differing time conventions can make the approximation poor.

Live model resets can start a new reference. Within one model, quality failures and basket changes reset IV trend/peak history but preserve the original move baseline. Replay resets rebuild from the prepared archive, so they can recover the same earliest valid historical reference. Read **DETAILS → Move reference** rather than assuming all three clocks—RTH open, IV baseline, and IV peak—are identical.

In the supplied screenshot, the value is unavailable. Do not derive a replacement move-used reading from the wide IV range.

## 8. Off IV peak

```text
OFF IV PEAK = (current ATM IV / highest observed comparable ATM IV − 1) × 100
```

This is a **relative percentage change in IV**, unlike impulse’s volatility points.

For a peak of 32% and current IV of 30%:

```text
Point difference = −2.0 IV points
OFF IV PEAK = (30 / 32 − 1) × 100 = −6.25%
```

The peak is the highest IV observed since the displayed `since` time in the comparable basket. It is not a claim about an unseen session high. Quality failure, a basket change, or an accepted-snapshot gap over 20 seconds clears/restarts that history.

An IV decline from peak can coexist with rising IV over the last minute: the latest bounce may still be below the earlier peak. Therefore, the watch rules require both a peak drawdown and a falling one-minute impulse. Peak distance alone is insufficient.

## 9. Actual pace: realized versus implied volatility

This card compares recent **stock price variability** with current ATM IV. It does not compare stock share volume with option volume.

The model takes the last stock price in each completed 10-second bin and calculates 30 log returns:

```text
r[i] = ln(price[i] / price[i−1])
RV5m = sqrt(mean(r[i]^2) × 252 × 390 × 6)
ratio = RV5m / ATM_IV
```

`252` is the annual trading-day convention, `390` is minutes in the regular session, and `6` is ten-second intervals per minute. This is a **root-mean-square return measure**; the implementation does not subtract the mean return before squaring.

| Ratio | Label |
|---|---|
| `< 0.75` | QUIET |
| `0.75` to `< 1.25` | NORMAL |
| `1.25` to `< 1.75` | ELEVATED |
| `>= 1.75` | EXTREME |

**Hypothetical:** RV5m `42.1%`, ATM IV `27.8%` gives approximately `1.51× IV`, or **ELEVATED**.

The useful reading is “recent stock movement is unusually active relative to this options-derived scale.” It does not mean realized movement is destined to persist, that options are mispriced, or that a 1.51 ratio gives a trading edge. Five minutes of realized stock activity and a longer-expiry IV are different horizons even after both are annualized. Bid–ask bounce, jumps, and sparse trading can also affect the measurement.

All **31 completed price bins** needed for 30 returns must exist. Missing bins are not forward-filled. With RTH-only observations beginning at 09:30, the first possible uninterrupted result is around **09:35:10**, not 09:31. A fresh stock print within 10 seconds is also required.

If options are unreliable but RV is valid, the card shows **RV ONLY** and the raw RV5m value. That is useful stock context, but there is no valid RV/IV ratio. `BUILDING` means unavailable history, not low volatility. This explains the screenshot at 09:31:54.

## 10. Put fear: the skew measurement

The implemented skew is:

```text
skew in volatility points = (IV of 25-delta put − IV of 25-delta call) × 100
```

It is **put IV minus call IV**, not put IV minus ATM IV. The model chooses the nearest delta to `−0.25` for the put and `+0.25` for the call, with a maximum distance of **0.08** from each target, in the selected expiry.

For put IV `34.2%` and call IV `25.6%`, skew is **+8.6 points**. An ATM IV of `27.1%` does not enter that subtraction.

The large label emphasizes the five-minute change:

| Five-minute skew change | Display |
|---|---|
| Strictly above `+0.2` points | RISING ↑ |
| Strictly below `−0.2` points | EASING ↓ |
| Between those boundaries, inclusive | STEADY |
| Current skew exists but comparable five-minute history does not | BUILDING |
| Required data absent or unreliable | `--` |

The smaller text contains the current skew and its five-minute change. The change requires the **same wing contract identifiers at both comparison endpoints**. A new wing selection can therefore remove the comparison. Wing quotes must also be fresh.

Rising skew means put IV is becoming higher relative to call IV. That may reflect higher put IV, lower call IV, or both. Do not narrate it as proof that new put buyers have arrived. A high positive skew can be easing; a negative skew can be rising. The label describes change, not an absolute HIGH/LOW ranking.

The display deadband differs from the watch rule: a change of `+0.1` points displays **STEADY** but fails the watch requirement `skewDelta <= 0`. Conversely, an unchanged skew satisfies “not rising” even though the compact check says `SKEW ↓`.

## 11. Buy flow and sell flow

### 11.1 Where the side comes from

The flow strip counts **underlying stock shares**, using each print’s assigned direction:

- Trades at or below the bid are assigned sell direction.
- Trades at or above the ask are assigned buy direction.
- Inside-spread prints use a tick-direction fallback: up versus the preceding trade is buy, down is sell, unchanged inherits the previous side.
- Recorded trades can retain their recorded side. Zero/unassigned direction contributes to neither buy nor sell shares.

Every completed transaction has a buyer and a seller. These assignments estimate the aggressive side; they do not identify intent, ownership, opening versus closing activity, or hidden orders. Quote timing and wide stock spreads affect interpretation. The screenshot’s stock spread is **$0.93**, which should remain part of execution context even though it is separate from the option-spread filter.

### 11.2 The two-window calculation

At each reading, the current partial second is excluded. The model compares:

```text
Prior window:  seconds [now − 60, now − 30)
Recent window: seconds [now − 30, now)
```

It chooses whichever classified side had more shares in the **prior** window. That side must be **strictly more than 1.2 times** the other side. Equal to 1.2 is not enough.

For the chosen side:

```text
Flow change percent = (recent side shares / prior side shares − 1) × 100
```

Requirements include a full minute of observed history, at least **10 prints in each window**, positive prior shares on the selected side, and a stock print within **10 seconds**. The print-count gate counts observed prints, not only those assigned to the selected side.

| Condition | Visible pace label |
|---|---|
| Change `< −25%` | SLOWER |
| Change `>= +25%` | FASTER |
| Otherwise | STEADY |
| Prior side not sufficiently dominant | MIXED, neutral TAPE FLOW |
| Insufficient history or print counts | BUILDING, neutral TAPE FLOW |
| Stock prints stale | STALE, neutral TAPE FLOW |

The negative boundary is strict: **exactly −25% is STEADY**. The positive boundary is inclusive: **exactly +25% is FASTER**. Internally the two moving states are named `SLOWING` and `ACCELERATING`; the UI translates them to SLOWER and FASTER.

### 11.3 Read side and speed separately

| Badge and pace | Literal interpretation | What it does not prove |
|---|---|---|
| Green BUY FLOW · FASTER | Previously dominant buy-classified shares increased at least 25%. | Price must rise. |
| Green BUY FLOW · SLOWER | Previously dominant buy-classified shares decreased more than 25%. | Sellers now dominate or a short entry is confirmed. |
| Coral SELL FLOW · FASTER | Previously dominant sell-classified shares increased at least 25%. | Price must fall. |
| Coral SELL FLOW · SLOWER | Previously dominant sell-classified shares decreased more than 25%. | Buyers have taken control or a bottom exists. |

The badge retains the side’s color when it slows. Slowing sells remain coral; slowing buys remain green. The pace text is separate so a slowdown is not mistaken for an opposite-side signal.

**Screenshot arithmetic, using invented share counts only to illustrate the ratio:** prior buys `10,000`, recent buys `9,060` produce `−9.4%`. If prior sells were `8,000`, the prior buy side passes the dominance test. The badge can remain BUY FLOW even if recent sells increase to `14,000`, because the side was selected from the earlier window.

This is why “green badge” is weaker information than “buyers currently control the stock.” Compare the badge with actual price progress, the latest prints, volume delta, and the age of the information.

## 12. Divergence and exhaustion rules

### 12.1 The four compact checks

| Check | What must be available and true |
|---|---|
| NEW LOW | Current stock price is strictly below the earlier comparison-window lows. |
| IV ↓ | Comparable five-minute IV history exists; one-minute IV is falling beyond the deadband; current IV is at least 3% below its observed peak. |
| SKEW ↓ | Same-wing five-minute put-minus-call IV change is available and non-positive. |
| SELLS ↓ | The previously dominant side was sell flow and its shares declined more than 25% across the adjacent windows. |

`✓` means met; `·` means evaluated and not met; `—` means insufficient usable/comparable data. When the options reading itself is unavailable, **all four checks are suppressed**, even if the stock-only low or flow could be calculated independently. A dash is not a false result.

The new-low comparison is quite specific: it compares the latest stock price with observed lows from **300 seconds ago up to 5 seconds ago**, excluding the newest five seconds. It requires history reaching at least five minutes back and at least **150 occupied seconds** in that comparison span. It is not a comparison of five one-minute candle closes, and it does not mean “the low of the entire day.”

### 12.2 IV DIVERGENCE

The headline appears only when all of these are true:

1. The stock makes the qualifying new five-minute low.
2. The previously dominant classified side is selling, with a share-flow decline **greater than 25%**.
3. One-minute IV change is below the negative IV deadband.
4. Current IV is at least **3% below** the observed comparable peak.
5. A full comparable five-minute IV change is available.
6. Five-minute put-minus-call skew change is available and **not rising**.

Subtle but important: the implementation requires the five-minute IV change to **exist**; it does **not** require that five-minute change to be negative. The falling-IV test is on the one-minute window, together with distance below peak.

The teaching interpretation is “a new price low is not being accompanied by the same near-term IV expansion and sell-flow pace.” That can be a reason to watch price response closely. It does not establish that the low will hold. The rule is **downside-only**; the code computes a stock new high too, but does not implement a mirror-image upside IV-divergence alert.

This is a **visual** alert. It does not emit an IV-divergence sound, submit an order, or override the existing tape audio.

### 12.3 EXHAUSTION WATCH

The rule needs:

- **Stretch:** IV move used at least **80%**, **or** the selected ADR extension at least **1.00**.
- **IV cooling:** current IV at least **5% below** its observed peak, and one-minute IV falling beyond the deadband.
- **Flow slowing:** the previously dominant classified side’s shares decline **more than 25%**.
- **Additional sell-side requirement:** when the side is selling, five-minute skew must be available and non-increasing.

For slowing buy flow, the current rule does not require skew confirmation. A new five-minute low is not required for this state. The headline’s reason names the slowing side; read it before assuming the setup concerns a downside reversal.

`WATCH` matters: the software recognizes a conjunction of stretch and cooling evidence, not a completed exhaustion event. Price can continue in the same direction after the watch appears.

### 12.4 Headline priority and non-independence

```text
If quality or freshness fails → availability/quality status
Otherwise:
    IV DIVERGENCE, if its full rule passes
    else EXHAUSTION WATCH, if its full rule passes
    else BUILDING IV TREND / VOL EXPANDING / VOL COOLING / VOL STEADY
```

The visible checks are explanations of related inputs, not four independent statistical confirmations. IV impulse and off-peak both use the ATM series; flow and volume delta share stock-print classifications. Counting them as unrelated votes exaggerates the amount of independent evidence.

## 13. Volume delta, RVOL, and Kronos

### 13.1 Volume delta is the fast stock-flow companion

For each displayed tick bar:

```text
share delta  = sum(trade shares × assigned direction)
dollar delta = sum(trade price × trade shares × assigned direction)
assigned direction is +1, −1, or 0
```

The screenshot selects **1T**, meaning one print per tick bar. In that setting a displayed `VOLUME DELTA −1` describes the latest plotted tick bar’s signed share amount, not the entire day’s net selling. Changing the tick aggregation changes how prints are grouped.

MAX DELTA and MIN DELTA summarize bar extremes in the visible window; their associated dollar figures are the dollar deltas of those bars. They are neither an account P&L nor the market’s cumulative net money inflow. The chart’s positive/negative scale is based on the largest absolute visible delta and can be symmetric even when the actual minimum is smaller.

Volume delta is quicker and more granular than the flow strip’s two 30-second windows. Agreement is useful descriptive context; disagreement may simply reflect the different windows, not a broken calculation. `TAPE 70/s` is a count of prints in the latest second, a third distinct measurement.

### 13.2 RVOL PACE is not RV/IV

The far-right `RVOL PACE 30× SURGE` concerns **share-volume pace**. The options card’s `ACTUAL PACE` concerns **price-return volatility**.

RVOL uses the current minute’s volume relative to the median volume of up to 20 preceding one-minute bars, requiring at least five baseline bars. During a forming minute, it adjusts for elapsed seconds and adds a five-second neutral prior to damp the earliest prints:

```text
forming-minute RVOL = (currentVolume / baselineMedian × 60 + 5)
                      / (elapsedSeconds + 5)
```

For a completed minute it is simply current volume divided by that median. It is not a same-time-of-day comparison against 20 previous trading days. Near the open, relatively quiet preceding bars can make the ratio very large.

Consequently, **30× RVOL** and **ACTUAL PACE BUILDING** are compatible. One has a usable volume baseline; the other lacks five minutes of completed RTH stock-return bins.

### 13.3 Read the screenshot’s Kronos panel carefully

Kronos is a separate experimental model using completed one-minute stock candles. The options module does not calculate its percentages, and this integration does not feed the six options-card values into Kronos.

The screenshot says:

```text
Selected horizon: 5m
Origin: 09:31 ET
Target close: 09:36 ET
Reference price: $793.345
Age: 54 seconds
Usable generated paths: 14 of 32
Above among usable paths: 100%
Below among usable paths: 0%
Invalid/unknown paths: 18
```

The arithmetic behind the warning is:

```text
Conditional above frequency = 14 / 14 = 100%
All-path above lower bound   = 14 / 32 = 43.75%, rounded 44%
All-path above upper bound   = (14 + 18) / 32 = 100%
All-path below lower bound   = 0 / 32 = 0%
All-path below upper bound   = 18 / 32 = 56.25%, rounded 56%
```

Those bounds describe uncertainty about invalid generated paths, **not confidence intervals for the market outcome**. The remaining usable paths can be a biased subset. `UNCALIBRATED` means the displayed sample frequencies have not been converted into empirically validated market probabilities.

“Above” compares the **terminal close at 09:36** with `$793.345`, the last completed input bar’s close. It does not compare with the approximately `$806` stock price at the moment of the screenshot. A hypothetical close at `$800` would be above the forecast reference while below the price being watched. The forecast also says nothing about whether a stop would have been hit along the path.

At 09:31:54, the 09:36 target is approximately **4 minutes 6 seconds away**, not five fresh minutes from the viewer’s glance. `BAR-ANCHORED` and the age label make this distinction explicit. The frontend withholds an old-origin reading once the next minute origin is due; do not treat a stale forecast as refreshed just because the stock tape is moving.

Keep Kronos visually subordinate to the current price, quality status, and tape. It adds a model hypothesis, not independent confirmation that a trade will work.

## 14. A practical reading routine and worked scenarios

### 14.1 A two-pass routine for a small screen

**First pass, a few seconds:** quality → ADR mode/stretch → IV headline → flow side/pace → current price response. With wide or missing options, the options portion of that pass ends immediately; ADR, volume delta, and stock flow can still be useful.

**Second pass, when there is time:** open DETAILS to check expiry, quote age, spread, move-reference time/price, peak-start time, and the state’s stated reason. An entry decision that depends on one of those anchors should not be based on guessing it.

The practical objective is to avoid two reading errors: fading a move just because a range measure looks large, and chasing a move just because one color or forecast percentage looks favorable. Position size, entry, invalidation, and execution remain part of the trader’s separately defined and tested plan.

### 14.2 Scenario A — stretch with continuing expansion

**Hypothetical later-session observations:** stock falling; IV move used 90%; ATM IV 31%; one-minute IV change +0.8 points; SELL FLOW FASTER +40%; no divergence confirmation.

Interpretation: the stock has traveled a large distance from the frozen reference while IV and classified selling are increasing. **90% is not evidence that only 10% of the move remains.** A teacher can ask the student what current price behavior would actually be needed to support a fade. The panel alone supplies no such entry trigger.

### 14.3 Scenario B — a watch, followed by price evaluation

**Hypothetical inputs:** initial stock $100 and IV 30%; stock now $98.30, giving approximately 90% move used; current IV 31%; observed IV peak 33%; one-minute IV change −0.8 points; previously dominant sell volume declines 40%; same-wing five-minute skew change −0.5 points.

IV is about **6.06% off peak**. The inputs satisfy EXHAUSTION WATCH. If the qualifying new five-minute low and comparable five-minute IV history are also present, IV DIVERGENCE takes headline priority.

Notice current IV can still exceed the initial 30% baseline while cooling from a 33% peak. “Cooling” does not mean “low IV.”

The next observation to study is price response: does selling continue to make meaningful progress, does the low fail again, or does a pre-defined price/tape setup appear? Those questions are trading hypotheses to test in replay. The code itself does not detect a reclaim, a higher low, absorption, or the best entry price.

### 14.4 Scenario C — the supplied screenshot

The chart is dramatic, but the options quality gate has failed. Use the ADR anchor and actual stock tape for what they measure; do not fill the dashes with a narrative of “fear is easing.” BUY FLOW STEADY does not overcome OPTIONS WIDE, and the Kronos 100% does not turn either into a confirmed long.

This is a valuable teaching example precisely because the correct options conclusion is **“insufficient reliable options evidence at this instant.”**

### 14.5 Scenario D — slower buying during a rebound

**Hypothetical:** FROM LOW is 0.9 ADR, BUY FLOW SLOWER −35%, and IV is cooling. The flow strip says buying has slowed relative to the prior window. It does not say selling has accelerated, and this alone does not satisfy EXHAUSTION WATCH: either selected ADR must reach 1.0 or IV move used must reach 80%, along with the other IV gates.

The student should compare the rebound’s price progress with the new prints instead of translating the green badge into “buy” or the slowdown into “short.”

## 15. Replay, missing data, and warm-up

### 15.1 Live snapshots and reconstructed replay are different sources

```text
Live:
  options provider → compatible local gateway → tape backend
                   → quality/selection model → panel

Replay:
  historical option quotes + historical stock prints
    → explicit preparation script → estimated-IV archive
    → tape backend, bounded by replay clock → panel
```

The public tape reader uses a documented gateway interface for options; provider credentials belong to the gateway. A particular private companion application is not required by the public interface. Ordinary tape/ADR functionality remains available without options. Public stock-data defaults remain IBKR; optional gateway configuration is a separate local choice.

Historical quote records contain bid/ask prices, sizes, and timestamps; they do not provide the historical vendor IV/Greeks used by a live snapshot. Compare the [Massive historical quotes schema](https://massive.com/docs/rest/options/quotes) with the [snapshot schema](https://massive.com/docs/rest/options/snapshots/option-chain-snapshot).

The repository’s preparation helper estimates IV by inverting European Black–Scholes:

- Midpoint price for the candidate point estimate; separate bid and ask inversions for the wide diagnostic.
- Interest rate `r = 0` and dividend yield `q = 0`.
- Calendar time on an **ACT/365** basis to **16:00 ET** on the selected expiry.
- No American early-exercise or carry adjustment.
- A numerical IV search, then model-derived delta.
- By default, the first expiry **strictly after** the replay date; a specific expiry can be requested explicitly.

The replay estimate is therefore not guaranteed to match the vendor’s live IV. A model-estimated delta can also affect which contracts qualify. Positive historical bid/ask sizes replace the live OI/volume gate, because those historical snapshot fields are unavailable to this preparation path.

The daily move formula uses `sqrt(252)`, whereas the replay option-pricing approximation uses calendar time. This is one reason the daily projection should be taught as a rough scale, not a precise remaining-session distribution.

### 15.2 Time and freshness

Live requests recur approximately five seconds after a ready result, and fifteen seconds after an unavailable result. That is not a promise of independent new market information every five seconds. Provider IV has no separately validated timestamp in this integration; quote age is used as the freshness proxy.

Historical archives are sampled at five-second intervals. The replay service returns only samples at or before its clock. Missing archives or a clock outside their range do not fall back to today’s live options. Pauses freeze historical time; seeking resets the model and rebuilds the applicable observed archive history.

Timestamp bounds prevent using later samples in a reading. They do not prove that a subsequently downloaded historical dataset is identical to what was available live before vendor corrections, or that replay estimates reproduce every real-time feed delay.

### 15.3 How long each reading needs

| Reading | Minimum relevant history or condition |
|---|---|
| ADR | Selected number of complete prior sessions and valid current RTH coverage. |
| ATM IV | Current accepted 4–6-contract basket and fresh stock prints. |
| IV impulse 30s / 1m / 5m | Comparable basket history reaching the respective comparison time. |
| Move used | First valid IV reference plus usable current options and stock readings. |
| Off IV peak | Observed comparable peak; history restarts after quality/basket/gap resets. |
| Stock flow | Full observed minute, at least 10 prints per half-minute, prior dominance, fresh print. |
| RV5m | 31 consecutive completed 10-second price bins, plus a fresh print. |
| Put-fear change | Usable wings and a comparable same-wing observation five minutes earlier. |
| Full downside divergence | All relevant IV/skew history plus qualifying five-minute stock coverage and flow slowdown. |

At the open, missing warm-up is normal. Premarket stock candles can give Kronos a completed input window while the options module’s RTH-only RV is still building. Different readiness states are not inherently inconsistent.

### 15.4 Common unavailable states

| Status | Teaching interpretation |
|---|---|
| OPTIONS OPTIONAL | No options gateway configured; the stock tool still has value. |
| OPTIONS NOT PREPARED | This historical options archive is unavailable. |
| OUTSIDE OPTIONS REPLAY | The clock is outside the prepared interval. |
| OPTIONS WIDE / OPTIONS TOO THIN | Quality is insufficient for the IV-derived signals. |
| NO USABLE OPTIONS | No qualifying options in the bounded search. This does not prove the stock has no listed options. |
| OPTIONS STALE / OPTIONS DELAYED | The freshness or real-time requirement failed. |
| WAITING FOR TAPE | A fresh underlying stock reading is required. |
| OPTIONS MARKET CLOSED | The panel’s RTH time gate is closed. Its basic weekday/clock filter is not a complete exchange-holiday calendar. |
| OPTIONS OFFLINE / UNAVAILABLE / ACCESS DENIED / RATE LIMITED | Connection, response, entitlement, or request-limit condition. |
| OPTIONS INCOMPLETE | The bounded chain fetch did not yield a complete acceptable result. |
| BUILDING IV TREND | Current options are usable but comparable one-minute IV history is not ready. |

When options fail, IV impulse, move used, peak distance, skew, and divergence confirmations are withheld. Valid stock flow and raw RV can remain. A halt or stale stock feed must not be mistaken for exhaustion merely because trading stopped.

## 16. Code and numerical exercises

These excerpts let a teacher connect the labels to their actual calculation. JavaScript excerpts are implementation fragments, not complete standalone programs. The Python exercise is standalone and uses invented inputs except for the explicitly labeled screenshot arithmetic.

### 16.1 The actual move baseline and IV comparison

From [`options-volatility-model.js`](../internal/server/web/options-volatility-model.js), with the baseline object formatted across lines for readability:

```javascript
const DAY_SCALE = Math.sqrt(252);

// First accepted snapshot only: later IV changes do not rewrite this.
if (!this.baseline) this.baseline = {
  at: payload.asOfMS,
  price: payload.spot,
  iv: selected.iv,
  move: payload.spot * selected.iv / DAY_SCALE
};

const offPeak = (c.iv / this.peak - 1) * 100;
const used = Math.abs(this.lastPrice - this.baseline.price)
  / this.baseline.move * 100;
const threshold = Math.max(.2, c.iv * 100 * .005);
```

`selected.iv`, `c.iv`, and `this.peak` are decimal IVs. `offPeak` and `used` are percentages. `threshold` is in **volatility points**. Preserving units is essential: applying the threshold directly to decimal IV would be wrong by a factor of 100.

### 16.2 The actual watch conditions

From the same model, reformatted without changing the conditions:

```javascript
const divergence =
  tape.newLow &&
  tape.side === 'sell' &&
  tape.weakening &&
  d60 !== null && d60 < -threshold &&
  d300 !== null &&
  offPeak <= -3 &&
  skewDelta !== null && skewDelta <= 0;

const exhaustion =
  (used >= 80 || adrExtension >= 1) &&
  offPeak <= -5 &&
  d60 !== null && d60 < -threshold &&
  tape.weakening &&
  (tape.side !== 'sell' ||
    (skewDelta !== null && skewDelta <= 0));

if (divergence) {
  state = 'IV DIVERGENCE';
} else if (exhaustion) {
  state = 'EXHAUSTION WATCH';
}
```

`d60` and `d300` are IV changes in points. `skewDelta` is the five-minute skew change in points. `tape.weakening` is the strictly-greater-than-25% decline in the previously dominant classified side’s share volume. These expressions execute only after the reading’s options and stock freshness gates have passed.

### 16.3 How estimated replay IV is obtained

The replay helper’s zero-rate, zero-dividend European price/delta function, from [`prepare-options-replay.py`](../scripts/prepare-options-replay.py):

```python
def price_delta(spot, strike, years, iv, kind):
    width = iv * math.sqrt(years)
    d1 = (math.log(spot / strike) + .5 * iv * iv * years) / width
    d2 = d1 - width
    cdf = lambda x: .5 * (1 + math.erf(x / math.sqrt(2)))
    if kind == 'call':
        return spot * cdf(d1) - strike * cdf(d2), cdf(d1)
    return strike * cdf(-d2) - spot * cdf(-d1), cdf(d1) - 1
```

Here `cdf` is the standard normal cumulative distribution function. The helper searches IV between `0.0001` and `10.0`, using 45 bisection iterations to match the chosen option price. Prices at/below intrinsic value, invalid time-to-expiry, and unsolvable inputs are rejected. More numerical precision does not remove the economic limitations of the pricing assumptions or wide bid/ask quotes.

For signal candidates the chosen price is the midpoint. For the diagnostic range, the helper runs the solver at bid and ask separately, then takes medians across the ATM basket. This explains why a range can be informative about **uncertainty in the estimate** while still being unsuitable for an IV trend signal.

### 16.4 Standalone arithmetic exercise

Save this block as a scratch Python file or run it in a notebook. It performs no network calls and needs no credentials. It reproduces the described arithmetic, not the complete production eligibility or state engine.

```python
from math import sqrt

# Approximate screenshot reconciliation, using its chart price.
price, rth_low, adr_fraction = 805.97, 791.75, 0.0539
from_low = price / rth_low - 1
print(f"From RTH low: {from_low * 100:.2f}%")
print(f"ADR extension: {from_low / adr_fraction:.2f}")

# Hypothetical frozen daily move, and current displacement.
initial_price, initial_iv, current_price = 100.0, 0.30, 98.30
daily_move = initial_price * initial_iv / sqrt(252)
move_used = abs(current_price - initial_price) / daily_move * 100
print(f"Frozen 1D move: +/- ${daily_move:.4f}")
print(f"Move used: {move_used:.2f}%")

# Point change is different from percentage change.
old_iv, new_iv = 0.30, 0.312
print(f"IV impulse: {(new_iv - old_iv) * 100:+.2f} points")
print(f"Relative IV change: {(new_iv / old_iv - 1) * 100:+.2f}%")
print(f"Off IV peak, 32% to 30%: {(0.30 / 0.32 - 1) * 100:.2f}%")

# Hypothetical share-flow change, assuming quality gates passed.
prior_buy, recent_buy = 10000, 9060
flow_change = (recent_buy / prior_buy - 1) * 100
flow_label = ("SLOWER" if flow_change < -25
              else "FASTER" if flow_change >= 25 else "STEADY")
print(f"Buy flow: {flow_change:+.1f}% / {flow_label}")

# Hypothetical realized/implied comparison and wing skew.
ratio = 0.421 / 0.278
print(f"RV/IV: {ratio:.2f}x (ELEVATED)")
print(f"Put-minus-call skew: {(0.342 - 0.256) * 100:.1f} points")

# Screenshot's conditional model frequency and unknown-path bounds.
above, usable, attempted = 14, 14, 32
unknown = attempted - usable
print(f"Kronos above among usable: {above / usable:.0%}")
print(f"All-path above bounds: {above / attempted:.2%}"
      f" to {(above + unknown) / attempted:.2%}")
```

Expected key outputs: **1.80%**, **0.33 ADR**, **$1.8898**, **89.96%**, **+1.20 points**, **+4.00%**, **−6.25%**, **−9.4% / STEADY**, **1.51×**, **8.6 points**, and **43.75%–100%** all-path above bounds.

### 16.5 Synthetic visual teaching material

The public repository includes a credential-free dashboard preview:

```sh
node scripts/options-dashboard-preview.mjs
```

Its ready and wide examples are served at [the local ready preview](http://127.0.0.1:18098/preview/ready) and [the local wide preview](http://127.0.0.1:18098/preview/wide). They intentionally use fabricated options, tape, and forecast values. Label any resulting teaching image **SYNTHETIC EXAMPLE**; it must not be presented as another moment from the STX session.

For implementation validation, relevant existing checks include `scripts/options-volatility-check.mjs`, `scripts/options-lifecycle-check.mjs`, `scripts/options-replay-check.py`, and `scripts/options-replay-lifecycle-check.mjs`. Tests exercise behavior; passing them does not establish predictive profitability.

## 17. A teaching-video storyboard

### 17.1 Suggested production brief

Create an approximately **15–20 minute** explainer for a stock scalper. Use the supplied screenshot as the recurring reference, magnifying one panel at a time. Keep equations and code for short worked-example segments or an appendix; avoid reading code aloud line by line. Preserve labels exactly and distinguish **observed**, **calculated**, **hypothetical**, and **unavailable** information.

Do not invent missing STX IV readings, a later price outcome, an entry/exit, a selected expiry not visible in the screenshot, or a performance record. Any illustrative future sequence must be labeled hypothetical. Explain the concepts before proposing how to observe them during replay.

| Scene | Visual focus | Teaching objective / suggested narration |
|---|---|---|
| 1. Start with the actual limitation | Zoom OPTIONS WIDE, 57–86%, and the dashes. | “The first thing to read is whether the information is usable. Here the software refuses to turn wide option quotes into a precise trading signal.” |
| 2. Orient the viewer | Outline the right-hand stack and the far-right tape column separately. | Identify stock delta, ADR/options, stock flow, Kronos, and the replay clock. |
| 3. Resolve the green ADR puzzle | Highlight FROM LOW, RTHL 791.75, and the chart price. | Calculate 1.80% and 0.33 ADR. Explain why green can appear after a severe decline. |
| 4. Explain options without an option-chain detour | Simple stock/strike/expiry diagram and an IV input box. | Explain IV as a model input inferred from price, annualized and non-directional. Distinguish option delta from share-volume delta. |
| 5. Demonstrate quote uncertainty | Synthetic bid $6, ask $10 → midpoint $8 → 50% spread. | Connect wide quotes to a broad IV estimate; explain why the dashes are useful honesty. |
| 6. Give each card one question | Six-card diagram. | ATM: how much uncertainty? Impulse: changing how fast? Move used: how far from the frozen reference? Peak: cooling from what observed level? Pace: how active is the stock relative to IV? Skew: how is put-versus-call pricing changing? |
| 7. Separate flow side and speed | Four BUY/SELL × FASTER/SLOWER examples. | “Slowing sells are still sells. Green indicates the prior dominant classified side, not a buy instruction.” Work through −9.4% and STEADY. |
| 8. Build the watch rule | Reveal the four divergence checks one at a time. | Explain AND conditions, missing data, the downside-only rule, and why WATCH is not an entry. |
| 9. Explain the opening warm-up | Timeline from 09:30 through roughly 09:35:10. | Flow needs one minute; RV needs 31 completed bins; five-minute comparisons need actual comparable history. |
| 10. Defuse the 100% trap | Highlight 14/32, 18 invalid, $793.345, and 09:36. | Recalculate 14/14 and 14/32; show that a hypothetical $800 target close can satisfy ABOVE while losing from a higher entry. |
| 11. Compare hypothetical setups | Expansion scenario beside exhaustion-watch scenario. | Ask how the context changes the questions a trader asks; do not prescribe a trade. |
| 12. Return to the real screenshot | Whole screen, then the quality headline again. | Ask the student for a one-sentence reading without inventing an IV signal. Finish with a pause-and-predict replay exercise. |

### 17.2 Short narration for the supplied image

> Start with the options status. It says OPTIONS WIDE, so the precise IV signals are withheld. The 57-to-86-percent number is an annualized IV estimate range derived from historical bid and ask quotes, not a forecast stock return.
>
> Above it, the selected ADR mode is FROM LOW. Using the chart’s roughly 806-dollar price and the 791.75 low, the stock is about 1.8 percent off that low—one-third of the 5.39-percent ADR. That describes a rebound inside a volatile session.
>
> The green BUY FLOW strip describes classified stock shares. The previously dominant buy side slowed by 9.4 percent between two half-minute windows, which the program labels STEADY. It does not tell us that calls are being bought or that the current selloff is finished.
>
> The five-minute realized-volatility measure is still building because the clock is only 09:31:54. The divergence dashes do not confirm anything. Finally, Kronos’s 100 percent is 14 out of 14 usable generated paths, with 18 other paths invalid, relative to a 793.345-dollar reference. It is not certainty about a profitable trade from the current price.
>
> At this instant, the reliable lesson is to keep the anchors and data quality straight, then evaluate the actual price and tape. The missing options signals should remain missing in our explanation.

## 18. Review questions and a replay worksheet

### 18.1 Questions a teacher can ask before revealing the answer

1. **Why is 0.33 ADR green while the chart shows a selloff?** It measures distance up from the running RTH low in FROM LOW mode.
2. **Does 57–86% mean the stock might move that far today?** No. It is a bid/ask-derived range of annualized IV estimates.
3. **Does −9.4% alongside BUY FLOW mean selling dominates?** No. It compares the prior dominant buy side’s shares across two windows; it does not directly report the recent side balance.
4. **Is exactly −25% SLOWER?** No. The implemented slowdown test is strictly below −25%.
5. **Can move used exceed 100%?** Yes. Its denominator is a frozen projection, not a boundary.
6. **Can a big round trip produce low move used?** Yes. It measures current displacement, not total distance traveled.
7. **Can PUT FEAR say STEADY while the skew check fails?** Yes. A small positive change fits the display deadband but fails `skewDelta <= 0`.
8. **Can RVOL say SURGE while ACTUAL PACE says BUILDING?** Yes. Volume pace and five-minute return volatility require different inputs and histories.
9. **Does every checked condition provide independent evidence?** No. Several share the same IV or stock-print inputs.
10. **Does IV DIVERGENCE require negative five-minute IV change?** No. The five-minute comparison must exist; the falling test is on one minute and off-peak distance.
11. **Does EXHAUSTION WATCH require a new low?** No. That requirement belongs to the downside divergence rule.
12. **Why is the Kronos 100% not a probability of profit?** It is a conditional model-sample frequency, uses a different price reference, excludes invalid paths, and does not model the proposed trade’s fills or stop.

### 18.2 A repeatable replay study

Pause before seeing the next move. Record the following, then advance a fixed interval. Use the same study rules across many sessions, including failures and periods when no options signal is available.

| Observation at the pause | Record |
|---|---|
| Symbol, session, replay time | The exact historical context. |
| Options quality and source | Ready/wide/missing/stale; live snapshot or replay estimate. |
| ADR context | Mode, lookback, RTH reference, extension. |
| IV context | ATM IV, expiry, 30s/1m/5m changes, peak-start time and drawdown. |
| Frozen move context | Baseline time/price/IV, daily dollar scale, move used. |
| Stock flow | Prior dominant side, change, label; current price response. |
| Pace and skew | RV, RV/IV if valid, wing skew and comparable change. |
| Watch evidence | Each check; distinguish false from unavailable. |
| Model context if consulted | Kronos reference, origin, target, usable count, invalid-path bounds. |
| Hypothesis before advancing | What observable price behavior would support or contradict it? |
| Outcome after fixed intervals | For example, 30s/1m/3m returns and excursions from the pause price. |
| Execution assumptions if studying a setup | Spread, slippage, costs, entry rule, invalidation, and exit rule. |

Compare a price/tape-only decision process with one that adds options context, using a predefined method. Do not select only attractive divergence examples after seeing the outcome. Do not optimize thresholds on the same few replays used to judge success. Record unavailable intervals too: a signal that rarely exists may have limited practical value for a particular stock or time of day.

This report makes no claim that the thresholds or Kronos have a measured edge. That would require a separate, appropriately controlled evaluation.

## 19. What is implemented and what is not

The original design discussion included more ideas than were shipped. A teaching video should explain the current implementation rather than silently upgrading it to the proposal.

| Idea | Current implementation |
|---|---|
| Compact ATM IV | Yes: median of accepted paired contracts, with selected expiry. |
| 30s, 1m, 5m IV impulse | Yes: actual point changes, subject to comparability. |
| Normalized IV impulse or pressure score such as +82 | No. |
| Frozen expected-move usage | Yes: first valid observation’s approximate daily projection. |
| Exact opening or remaining-day implied move | No. |
| Realized/implied regime | Yes: the specified five-minute return estimator and fixed bands. |
| Put skew | Yes: 25-delta put IV minus call IV, with five-minute change. |
| Absolute calibrated HIGH/LOW fear score or IV percentile | No. |
| 0D/7D term-structure comparison | No. |
| Options transaction tape, aggressive call/put flow, or options-volume pressure | No. The prominent flow strip uses stock trades. |
| Gamma exposure, dealer inventory, vanna/charm positioning, or gamma walls | No. Availability of some Greeks in a provider response does not implement these analyses. |
| Volatility-acceleration score | No separate score. The three impulse windows are displayed. |
| IV divergence | Yes: the specific downside-only visual rule. |
| Audible IV-divergence alert | No. Existing tape audio is separate. |
| Exhaustion | EXHAUSTION WATCH only: a heuristic context state. |
| Kronos percentage as validated win probability | No. Uncalibrated model-sample frequencies are displayed with quality context. |
| Use without a private companion or options subscription | Core stock tape/ADR remains useful; options use an optional documented gateway or prepared archive. |

The most useful interpretation is often a restrained one: a field answers its specific question, and an unavailable field contributes no evidence.

## 20. Source map and further reading

### 20.1 Repository sources

These paths are public implementation references. The detailed behavior in this guide was checked against commit `9ac3be4`; later code changes can alter thresholds or presentation.

| Source | What it establishes |
|---|---|
| [`options-volatility-model.js`](../internal/server/web/options-volatility-model.js) | Contract selection, IV history, frozen baseline, RV, flow, skew, watch conditions, freshness. |
| [`options-volatility-panel.js`](../internal/server/web/options-volatility-panel.js) | Visible text, source labels, unavailable states, DETAILS, polling and replay lifecycle. |
| [`options-volatility.css`](../internal/server/web/options-volatility.css) | Expansion/cooling/watch colors and side-versus-speed flow presentation. |
| [`adr-rth-extension-model.js`](../internal/server/web/adr-rth-extension-model.js) | Exact ADR and FROM LOW/HIGH formulas, RTH context. |
| [`adr-rth-extension-panel.js`](../internal/server/web/adr-rth-extension-panel.js) | Controls, ADR meter, selected extension passed to the watch rule. |
| [`options.go`](../internal/server/options.go) | Bounded live options gateway requests and response normalization. |
| [`options_replay.go`](../internal/server/options_replay.go) | Archive validation and replay-clock sample bounds. |
| [`prepare-options-replay.py`](../scripts/prepare-options-replay.py) | Historical quote selection, pricing approximation, IV inversion and wide diagnostic. |
| [`tape/store.go`](../internal/tape/store.go) | Trade classification and side assignment. |
| [`tape-model.js`](../internal/server/web/tape-model.js) | Tick-bar share/dollar delta, print rate, and RVOL pace. |
| [`app.js`](../internal/server/web/app.js) | Delta rendering, visible extrema, and screen layout. |
| [`kronos-model.js`](../internal/server/web/kronos-model.js) | Conditional sample frequencies, invalid-path bounds, origin and reference validation. |
| [ADR + Options Vol](OPTIONS_VOLATILITY.md) | Operational overview and preview/replay setup. |
| [Options gateway contract](OPTIONS_GATEWAY.md) | Public optional-service and offline-archive interfaces. |
| [ADR RTH extension](ADR_RTH_EXTENSION.md) | Additional ADR coverage and behavior documentation. |
| [Kronos forecast](KRONOS_FORECAST.md) | Forecast lifecycle, data provenance, and interpretation limits. |

For exact boundary conditions, the code controls. In particular, this guide follows the implemented **strict** prior-side dominance `> 1.2×` and slowdown `< −25%`; prose summaries such as “20% dominant” or “25% slowdown” can obscure equality at the boundary.

### 20.2 External background and its role

External references are linked beside the claims they support above: OIC for option rights, pricing, IV, and delta; Cboe for skew and daily volatility scaling; Massive for provider schemas. They explain general concepts or available data. **They do not validate this tool’s numerical thresholds, its replay solver assumptions, its watch rules, or a trading edge.** The repository defines those choices.

For a visual supplement, [OIC’s Understanding Volatility and Options](https://www.optionseducation.org/videolibrary/understanding-volatility-and-options) includes segments on historical volatility, IV, vega, and skew. A teacher can use those concepts to explain why option prices react to more than stock direction, while keeping this tool’s exact calculations separate.
