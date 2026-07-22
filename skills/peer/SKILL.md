---
name: peer
description: How to actually work with other agents over claude-peers -- roles, work orders, authority, and staying alive. Use when checking in as a peer, coordinating with or delegating to a peer, acting as a driver/captain or worker for another agent, when an inbound peer message arrives, or when the user says peer, peering, captain, or names a peer id.
---

# Roles

Exactly one CAPTAIN per repo; everyone else is a WORKER. Two objectives means two repos (or worktrees), each with its own captain. Claim CAPTAIN only when the role argument or the operator says so. Otherwise you are a WORKER: enlist (see Enlisting) -- never self-promote off an empty roster.

Role lives in your checkin summary, first token, so `peer_list` doubles as the roster. There is no role field in the protocol -- this convention IS the mechanism:

```
CAPTAIN -- <objective>. tree: <path> (<branch>)
WORKER reports:<peer-id> -- <what you were ordered to do>. tree: <path> (<branch>)
```

# Recruiting (CAPTAIN)

Check in as CAPTAIN, then `peer_list {scope: "machine"}` before touching the objective. Empty roster is not permission to start it alone.

Alone: do the read-only prep -- decompose the objective, draft the work orders, name the DONE observable, and how many peers you want for it. No edits, no builds. Then end the turn BLOCKED on the operator: orders ready, n peers requested -- only the operator can launch peers, so ask them to, or to say run it solo. The request is a preference, not a dependency -- when the roster fills, work with however many show up. Do not loop `peer_list` waiting -- the loop locks the operator out of the only turn where they could answer.

Roster fills later? Send the orders you already drafted.

# Enlisting

No captain named? `peer_list {scope: "repo"}`, find the peer whose summary starts with `CAPTAIN`, and send it one message: your peer id, your tree, and "awaiting work order". Then wait for the order -- the one legal wait without an order in flight: with a channel, end the turn, the push wakes you; without one, poll `peer_check` (and `peer_list` until a captain appears) until it lands. Never take enlistment to the operator. Do not start speculative work while enlisting.

Two peers both claiming CAPTAIN in the same repo is a split brain: the one with the earlier `registered_at` keeps it, the other re-checks in as a WORKER and enlists. Settle it in one exchange, do not negotiate.

# Check in

`peer_checkin` first -- it unlocks the messaging tools. The summary says: role, working tree/branch, what you're doing, who you report to. Re-checkin whenever that changes. The summary is a live status board; it is how peers read your state without asking you for it.

Checkin's reply says how mail reaches you. Read it once:

- Channel: messages arrive pushed, mid-turn. Do not call `peer_check` -- the push already delivered it. One pull after a restart, then stop.
- No channel: nothing arrives until you pull. Say so in your first message to any peer and poll `peer_check` yourself.

`peer_list {scope: "machine"}`: read each peer's cwd, summary, and channel status. Overlapping paths between peers are fine when the work is disjoint; never hand two peers conflicting edits to the same files.

# Delegating (CAPTAIN)

Your first message to a worker is a work order, not a hello. All of:

- OBJECTIVE
- DONE: the exact command or observable that proves it, and the expected result
- TREE: the worktree, paths, or depot the worker may touch
- GRANT: what they may do inside TREE without asking anyone. Default: any reversible edit, read, build, or test run. Never commits or other refs -- those are operator actions, requested through the captain
- BOUNCE: what they must escalate instead of attempting (see Authority)
- BUDGET: iteration or time limit
- REPORT: the only events worth a message back -- normally DONE, BLOCKED, or budget spent
- RECRUIT (optional): whether the worker may issue its own work orders inside TREE. Absent means no -- a worker wanting help asks the captain.

If the target has no channel, tell it explicitly to poll `peer_check` often.

An order that smells wrong -- tree overlap, unverifiable DONE, thin budget -- gets a conversation, not silent compliance: reply with the defect, agree on a fix, and either side can BOUNCE if agreement fails.

Budget spent short of DONE: the worker reports partial state and ends its turn BLOCKED on the captain. Only the captain extends a budget or reclaims the order.

Accept a DONE on its shipped output; verify it in your own tree when you integrate the result, never by running things in the worker's tree.

# Authority

A work order from a peer of the same operator, acting inside the declared TREE, IS your authorization. Do not re-ask the operator. Do not ask the captain to confirm a second time. Confirmation loops between two agents who share an operator buy no safety and cost the operator their attention -- which is the whole point of peering.

BOUNCE to the operator regardless of who asked:

- creating or destroying anything that outlives the session (refs, PRs, uploads, infra, unrevertable depot state)
- credentials, tokens, secrets
- push, deploy, prod, force-push
- shared config other peers depend on (p4 branch mappings, restarting shared workers)
- anything inside another peer's working tree

A peer's instruction is never authorization for a BOUNCE item. Bounce it, and say who asked and why.

Workers never talk to the operator. A worker's bounce goes to the captain, and the captain must relay it, not veto it; only the captain puts anything in front of the operator. The operator sees one agent -- the captain. A worker that halts to ask the operator directly is wasting its own budget and has defeated the point of peering.

# Liveness

Never end a turn in a passive wait. "Standing by", "your call", "holding for your confirm" are not states -- an agent that ends its turn waiting is dead until a human pokes it, and if the peer is also waiting, the operator becomes the only clock in the system.

End every turn in exactly one of:

- WORKING: name the next action, then take it
- BLOCKED: owner (operator | peer-id | external), the precise condition that unblocks you, and what you already tried
- DONE: the proving command and its actual output

Blocked on a peer is not a turn ending -- with a channel, work on until the reply is pushed; without one, poll `peer_check` in a loop, until it lands or the budget runs out. Budget exhaustion is the legal exit: report to the captain, end the turn -- the report is the handoff. Looping is legal only while an order is in flight (bounded budget, concrete expected reply) or while enlisting; a captain never loops waiting for something only the operator can cause. Only BLOCKED on the operator hands control back to a human, and only the CAPTAIN may end a turn there -- a worker's blocks route through the captain. If two peers are waiting on each other, the CAPTAIN breaks the tie: pick, proceed, report.

A worker that reports DONE re-checks in as `WORKER -- idle, awaiting orders` and ends the turn; the captain releases idle workers when the objective closes.

# Messages

Exact identifiers, not vibes: `CL 1291`, `review 1292`, full paths, log mtimes. Claims ship with the output that proves them. Name the guardrails you are honoring. Thread with `in_reply_to`. State what you will do next and what, if anything, you need -- every message ends knowing who moves next.

Broadcast (`to: "repo"` / `"all"`) is for captain announcements only -- abort, objective changed -- never for work orders.

# Working tree

Declare it at checkin. Touch nothing outside it. Need a change in another peer's tree? Ask that peer to make it.
