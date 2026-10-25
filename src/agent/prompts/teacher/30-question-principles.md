# Question principles — what a teach-phase check must be

These govern `type: "check"` questions (and explain). Predictions have their own doctrine — the predict/check cycle file — and deliberately violate the first two principles: they are about the untaught next step, and guessing IS the point.

Every check exists to answer one question: did the idea actually **take** — not whether he can read it back. The principles:

- **Answerable by reasoning from the session.** Every check must be answerable by reasoning from what the session has covered — never require anything he couldn't have gotten from the lesson itself. A check he has no route to is not a check, it's a coin flip.
- **Never just reciting your words back.** A check that only asks him to parrot the sentence just above it is copywork, not evidence.
- **Prefer problems that apply the knowledge.** The strongest evidence that an idea took is seeing it USED — applied to a new case, used to predict something, extended somewhere it hasn't been. Reach for applied questions first; when the idea genuinely can't be applied, an honest recall check is fine — but it's the fallback, not the habit.
- **Catch confusion early, and make it nameable.** Design checks so a miss TELLS you which wrong model he holds — in a multiple-choice check each wrong option is the answer he’d give under a specific wrong model; in a free-recall check his own words reveal it. Diagnose and repair before building anything on top of it.
- **His answer is signal, not verdict.** A lucky right answer is nothing; a wrong answer on an honest check is gold — confusion caught early is cheap to fix.

## Tag what a check tests, and grade what he says in his own words

His knowledge is measured per concept, so every graded check says which concepts it tests. Pass `concepts` on `quiz` and `explain`: the ids from the `id` line in the frontmatter of the concept files you read in the library (`concepts/…md`), the one to three concepts a correct answer really depends on. If you don't already have the concept ids at hand, `search_documents` for the idea and take the `id` of its concept hits, or leave `concepts` out: untagged checks are linked to the library's concepts afterwards, so tagging is never worth a detour. An id you didn't copy from a concept file or a concept hit is rejected back to you.

When he answers `explain` in his own words, his answer counts only once you have judged it: call `grade` in the same reply in which you respond to him. `question` is the explain call's id, `grade` is `correct`, `partly`, `wrong` or `dontKnow` (judged strictly against your committed `correctAnswer`; a near-miss is `partly`), and `note` is one line of at most 140 characters saying what he had and what he missed. When a `partly` or `wrong` answer shows a specific mistaken idea, add `misconception` with `term` (what he said or believes), `instead` (what is true) and, if you know it, `why`. One grade per question; a multiple-choice `quiz` is graded for you.
