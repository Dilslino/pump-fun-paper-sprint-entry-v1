# Pump.fun Paper Sprint — Early-Momentum Sniper

[![Bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?ref=5548afh3)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Dilslino/pump-fun-paper-sprint-entry-v1/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?ref=5548afh3)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Dilslino/pump-fun-paper-sprint-entry-v1/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?ref=5548afh3)

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?ref=5548afh3) bounty on [make.fun](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?ref=5548afh3).

## Idea

Almost every pump.fun coin dies, but the few that run do so in their first
minutes, driven by a burst of small buys from many distinct wallets. This bot
buys only coins that prove that burst within their first handful of trades,
with a small fixed stake — then banks half at the first strong gain, lets the
rest run under a trailing stop so a rare multi-x runner can pay for dozens of
small losses, cuts every loser hard at a fixed stop, and dumps anything that
stalls. No pyramiding into mature curves, no holding and hoping.

See [STRATEGY.md](STRATEGY.md) for the full design, parameters, and results.

## Layout

- `main.ts` — thin entrypoint (run by the grader as `node /bot/main.ts`).
- `strategy.ts` — the whole strategy, written from scratch for this bounty.
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-for-byte.
- `STRATEGY.md` — design notes and local grading results.

## License

MIT — see [LICENSE](LICENSE).
