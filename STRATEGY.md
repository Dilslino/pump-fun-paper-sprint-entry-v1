# Strategy: Early-Momentum Scalper

## The observation that drives everything

On pump.fun, the return distribution is brutally fat-tailed: nearly every
coin grinds to zero, and a handful go multi-x in minutes. Any strategy that
buys mature curves and holds (the momentum pilot: **−9.45 SOL**, drawdown
95.6%) dies by pyramiding into the top. Any strategy that buys everything
early and never sells (equal-weight baseline: **−0.023 SOL** but only 5 coins,
never compliant) dies by the 5-position cap. The closest baseline, the pilot
sniper (**−0.42 SOL**, 343 coins, 12.8% win rate, 0.23 SOL fees), shows the
shape of the fix: it was only ~0.0012 SOL per coin from breakeven. So the
job is not a new archetype — it is a sniper with better entry selection and
better exits.

## What the sweep actually found

Nine rounds, ~70 graded variants on the kit's dev window (24 h, 2–3 Nov
2026, 1,222 coins, 128,058 events). Three findings survived every round:

1. **Entry strictness is everything.** The single biggest jump came from
   requiring 5–6 straight buys (100% buy share) from ≥4 distinct wallets:
   −0.52 SOL (loose, 404 coins) → −0.115 (strict, 123 coins) → −0.020
   (strictest, 86 coins). Relaxing any one gate — 3/4 buy share, 3–4
   trades, volume-share instead of count-share — admitted dozens of bad
   coins and made the total worse. The 5th and 6th consecutive buys do
   real work: coins that survive them behave differently from coins that
   merely start with buys.
2. **Scalping beats letting runners run.** Banking half at +35–50% with a
   wide trailing stop (the original design) lost to selling everything at
   +10–15% with a −6–8% stop: −0.070 → −0.014. The runners that would pay
   for the book mostly do not survive the 2-slot latency and the fade;
   the burst itself is the trade.
3. **Fees are the floor.** A round trip costs 2.5% in curve fees plus
   210,000 lamports in tx fees. At the minimum 0.012 SOL stake that is
   ~4.25% per coin, so gross edge has to clear ~4% before the net turns
   positive. The shipped bot's gross edge is ~+3.3% per coin — close, but
   still short of breakeven on this window. The honest read: this entry
   is a high-probability small loser on the dev window, with a real but
   modest chance of a positive final window (see Stress below).

Two signals tested and **rejected**: buy-volume share (worse than trade
counts once the 100%-buy gate is on) and a creator-buy minimum (it drops
coins without improving per-coin results). A whale-sell exit (one sell
taking >20% of the real reserve) **helped** and is shipped.

## Entry: prove the burst, then buy the minimum

A coin becomes a candidate at its `CreateEvent` and is judged on its first
trades only (6–10 trades). It is bought, once, when all of these hold:

- **Buy pressure:** all 6+ observed trades are buys (100% buy share).
- **Breadth:** at least 4 distinct wallets buying (one wallet spamming buys
  is usually the creator or a bundler, not a crowd).
- **Early momentum, bounded:** price up 5%–45% vs the create price. Below
  5% nothing is happening; above 45% we are chasing the top of the burst
  (the 45–50% band tested clearly worse).
- **Still young:** real SOL reserve at most 10 SOL — no mature curves.
- **No creator dump:** any sell by the creator blacklists the coin forever.
- **Sizeable:** the 1%-of-real-reserve buy cap allows at least 0.012 SOL, so
  the round trip clears the 0.01 SOL guardrail minimum with margin.

Stake is a fixed **0.012 SOL** per coin — the smallest amount that still
clears the round-trip minimum. This is deliberate: with gross edge near
zero, a bigger stake only scales the loss; the minimum stake minimises the
absolute loss per coin while keeping the full coin count. Capital (10 SOL)
is never the constraint; the 5-position cap and the entry rate are.

## Exits: scalp fast, cut faster

Every held position is re-checked each batch against its fill cost basis
(`cost_lamports / token_amount`, so the reference price is what we actually
paid, fees included):

- **Take profit:** at +10%, sell the whole position. This banks the burst
  before the almost-inevitable fade.
- **Hard stop:** exit everything at −8%.
- **Time stop:** after 200 slots (~80 seconds) without reaching +10%, exit.
  A coin that cannot move in its first minutes almost never moves later,
  and the slot is worth more deployed on a fresh launch.
- **Creator dump / whale sell:** any sell by the creator, or a single sell
  taking >20% of the real reserve, exits immediately, whatever the price
  says.
- **Trailing stop (backstop):** once the peak return reaches +10%, exit if
  the return falls 6 points below the peak. With the shipped take-profit
  selling everything at +10%, this rarely fires; it guards positions whose
  take-profit sell is still in flight.

Sells in flight are tracked so a second sell for the same tokens is never
sent before the first resolves (that would only earn an
`insufficient_tokens` rejection). A rejected or failed take-profit re-arms
itself. Orders use wide-open slippage (10,000 bps): with 2-slot latency, a
tight slippage band would turn exits into rejections exactly when exiting
matters most.

## Determinism

Decisions use only the batch data the harness delivers (slots, reserves,
trade events). No clock, no environment, no randomness. The same input
stream always produces the same orders, so the two grading executions
match byte for byte.

## Parameters (shipped)

| Parameter | Value | Why |
| --- | --- | --- |
| Stake | 0.012 SOL | Minimum viable; minimises absolute loss per coin |
| Min buy | 0.012 SOL | Clears the 0.01 SOL round-trip bar with margin |
| Entry window | 6–10 trades | 6 straight buys is the quality cliff |
| Min buy share | 4/4 (100%) | The burst must be all buying |
| Min distinct buyers | 4 | Breadth, not one wallet |
| Rise on entry | +5% to +45% | Momentum without chasing the top |
| Max real reserve | 10 SOL | Young curves only |
| Take profit | +10%, sell all | Scalp the burst |
| Trailing stop | arms +10%, drops 6 pts | Backstop only |
| Hard stop | −8% | Cut losers fast |
| Time stop | 200 slots, needs +10% | Dump stallers in ~80 s |
| Whale-sell exit | >20% of real reserve | One big dump ends the trade |

## Local results (dev window, 24 h, 2–3 Nov 2026)

Graded with `grade-local --driver process` on the kit's dev window
(1,222 coins, 128,058 events). The shipped configuration is the `r10a`
cell; neighbouring cells (TP 9–12%, stop −7–−8%, time-stop 150–300 slots)
all land within −0.012..−0.015 SOL, so the choice is a stable region, not
a lucky grid point.

| Variant | Net PnL (SOL) | Coins | Win rate | Drawdown | Fees (SOL) |
| --- | --- | --- | --- | --- | --- |
| v1 (first cut, loose) | −0.521 | 404 | 21.8% | 5.4% | 0.28 |
| v6 (strict entry, tight exits) | −0.115 | 123 | 26.8% | 1.2% | 0.086 |
| r5i (strict + TP40/trail6) | −0.070 | 123 | 23.6% | 0.8% | 0.072 |
| r6a (scalp TP15/stop−6%) | −0.062 | 123 | 24.4% | 0.7% | 0.072 |
| r7e (scalp + min stake) | −0.055 | 123 | 23.6% | 0.6% | 0.063 |
| r8i (6 trades + scalp) | −0.020 | 86 | 27.9% | 0.36% | 0.044 |
| r9g (TP10/stop−8%/time200) | −0.014 | 86 | 32.6% | 0.32% | 0.044 |
| **r10a = shipped** | **−0.012** | **103** | **33.0%** | **0.33%** | **0.053** |
| Pilot sniper (baseline) | −0.42 | 343 | 12.8% | 4.6% | 0.23 |

vs the pilot sniper baseline: 35x smaller loss, 2.6x the win rate,
14x smaller drawdown — and 103 coins in 24 h, which projects to ~26
round trips in the 6-hour final window, above the 20-coin guardrail with
margin. (The 86-coin cells project to ~21 and were rejected for that
reason despite similar per-coin results.)

## Stress

`grade-local --stress 10 --stress-jobs 2` (10 rebuilt copies of the dev
window), run on the shipped configuration:

| Copy | Net PnL (SOL) |
| --- | --- |
| blocks-01 | −0.07 |
| blocks-02 | −0.02 |
| blocks-03 | +0.01 |
| blocks-04 | −0.06 |
| blocks-05 | −0.05 |
| blocks-06 | −0.05 |
| blocks-07 | −0.09 |
| blocks-08 | +0.01 |
| blocks-09 | −0.08 |
| blocks-10 | −0.08 |

Median **−0.06 SOL**, p10 −0.09, p90 +0.01; 8 of 10 copies lost money; the
dev score (−0.012) sits above 8 of 10 copies. Honest read: the median
stress copy is negative, so a positive final window is a ~1-in-5 outcome,
not the base case — the bot's edge (~+3.3% gross per coin) does not yet
clear the ~4.25% round-trip fee on a typical window. What the stress does
show is stability: the loss is a narrow grind (−0.02..−0.09 across copies),
and the drawdown stays under 1% everywhere. Concentration is moderate
(the top 3 coins make 38% of the gains; without them the dev net would be
−0.04 instead of −0.012). The final window is a fresh 6-hour draw; with
~26 expected coins and a per-coin distribution centred just below zero, a
positive final is plausible but not favoured — which is still far ahead of
every baseline on this kit.
