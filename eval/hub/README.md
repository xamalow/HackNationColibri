# Hub SMS approval: independent spoofing suite (Nat lane)

Gate for Carter's guardrail 3: an SMS approval counts only from Noor's **enrolled number** AND with the **one-time
code of that proposal**, unchanged since the code was sent, unexpired, unused. Anything else approves nothing and
leaks nothing.

```
node eval/hub/sms_approval_suite.mjs <path to apps/hub>    # JSON report on stdout, exit 1 on any failure
```

Black-box against `apps/hub/src/commands.mjs` (`handleOwnerSms`) and `src/store.mjs`. Expected outcomes were written
before the first run. Phone numbers are synthetic zero-pattern placeholders.

| Id | Scenario |
|---|---|
| S01 | Spoofed sender with the right id and code: no approval, no reply, Noor's code not burned |
| S02 | Replayed approval SMS |
| S03 | Expired code |
| S04 | Clock set back after expiry |
| S05 | Code of proposal A used on proposal B |
| S06 | Proposal content changed after its code was sent |
| S07 | Bare yes ("NDIYO", "ndiyo", "NDIYO B", "YES", "1") |
| S08 | Noor's free-text suggestion ("nitachelewa kidogo") is never a yes |
| S09 | Five wrong codes lock the proposal; the right code is then refused |
| S10 | Spoofed HAPANA cannot cancel Noor's proposal |
| S11 | Spoofed command creates nothing and receives no code |
| S12 | Read-back goes to the enrolled number, whatever format the sender used |
| S13 | A relative date ("FUNGA jumamosi") is read back as the exact date before any approval |
| S14 | An approval smuggled inside another command |
| S15 | Happy path: Noor's own code, on time, approves exactly once |

**Sensitivity:** four flaws injected one at a time into a local copy of the hub are each caught. Any sender
accepted → S01, S10, S11; no expiry check → S03; code not bound to content → S06; no lockout → S09.

**Not covered yet:** the tourist side of SMS booking (request → availability → proposal → reply to the tourist) is
being built (Max's plan); fixtures for it follow. Real SMS transport (sender-ID spoofing at the carrier) is out of
scope: the suite tests the hub's decision, not the network.
