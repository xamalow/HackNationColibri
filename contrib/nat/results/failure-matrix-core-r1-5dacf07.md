# Failure matrix run on Domain core r1 @ 5dacf07 (2026-10-03)

Expectations were pre-registered in `eval/failure-cases.json` before any run. Harness: `contrib/nat/faults/run_failure_cases.mjs`. It uses only the core's public API and Nat's own transactional in-memory store with fault injection (crash mid-transaction, disk full); it does not reuse Domain's tests.

```
node contrib/nat/faults/run_failure_cases.mjs <core-r1>/packages/core/dist <core-r1>/contracts
```

**Result: 15 of 15 cases pass (45 checks).**

| Case | Area | Checks | Result |
|---|---|---|---|
| FC-01 | approval | 6 | PASS |
| FC-02 | durability | 3 | PASS |
| FC-03 | durability | 3 | PASS |
| FC-04 | sync | 2 | PASS |
| FC-05 | transport | 5 | PASS |
| FC-06 | transport | 4 | PASS |
| FC-07 | calendar | 2 | PASS |
| FC-08 | approval | 4 | PASS |
| FC-09 | clock | 2 | PASS |
| FC-10 | durability | 1 | PASS |
| FC-11 | identity | 4 | PASS |
| FC-12 | approval | 1 | PASS |
| FC-13 | facts | 1 | PASS |
| FC-14 | injection | 1 | PASS |
| FC-15 | facts | 6 | PASS |

**Is the harness able to fail?** Four bugs were injected into a local copy of the core build, one at a time; each was caught:

| Injected bug | Cases that failed |
|---|---|
| Dispatch sends the live (edited) envelope instead of the pinned approved bytes | FC-01, FC-03, FC-06, FC-08, FC-09, FC-12, FC-13 |
| A send interrupted by a crash is re-queued instead of send_unknown | FC-03 |
| Offline (tentative) booking requests are confirmed | FC-07 |
| Any owner session is accepted | FC-11 |

**Not proven by this run:**

- **Phone durability.** FC-02, FC-03 and FC-10 exercise the core's transaction-port logic with an in-memory store. The phone's SQLCipher database must still be tested on the device (force-quit, full storage).
- **FC-14 (injection)** is covered by the W3 fixtures, not by this harness.
- **Real carriers.** Provider receipts are simulated; real SMS/WhatsApp callbacks are not exercised.
