# PR Workflow - Mandatory Quality Checks

## 🚦 Before Creating PR (CRITICAL)

**⚠️ MANDATORY**: Run quality checks BEFORE creating PR to prevent multi-iteration review cycles.

### Recommended Workflow

```bash
# Step 1: Stage your changes
git add .

# Step 2: Run comprehensive pre-PR check (MANDATORY)
bash scripts/pr/pre_pr_check.sh

# Step 3: Only create PR if all checks pass
gh pr create --fill

# Step 4: Request Gemini review
gh pr comment <PR_NUMBER> --body "/gemini review"
```

### What pre_pr_check.sh Does

1. ✅ Runs `quality_gate.sh --staged --with-pyscn` (complexity ≤8, security scan, PEP 8)
2. ✅ Runs full test suite (`pytest tests/`)
3. ✅ Checks import ordering (PEP 8 compliance)
4. ✅ Detects debug code (print statements, breakpoints)
5. ✅ Validates docstring coverage
6. ✅ Reminds to use code-quality-guard agent

### Manual Option (if script unavailable)

```bash
# Run quality gate
bash scripts/pr/quality_gate.sh --staged --with-pyscn

# Run tests
pytest tests/

# Use code-quality-guard agent
@agent code-quality-guard "Analyze complexity and security for staged files"
```

## ✅ Merging Contributor PRs — Pre-Merge Checklist (MANDATORY)

Before approving and merging any contributor PR, verify ALL of the following:

1. **CI green** — all required checks pass (`gh pr checks <N>`)
2. **Gemini review read** — `gemini-code-assist` posts automatically on every PR. Read its findings before approving. Even a COMMENTED (non-blocking) review may surface real bugs.
   ```bash
   gh pr view <N> --json reviews --jq '.reviews[] | select(.author.login == "gemini-code-assist") | .body'
   gh api repos/doobidoo/mcp-memory-service/pulls/<N>/comments --jq '.[] | select(.user.login == "gemini-code-assist") | {path,line,body}'
   ```
3. **Own review complete** — diff read, security paths checked, findings addressed
4. **All open threads resolved** — no unresolved REQUEST_CHANGES reviews

> **Why**: PR #1025 (2026-05-27) was approved and merged before reading the Gemini review. The bot had flagged a real bug (`_Path(env_override)` not calling `.expanduser()`). Required a follow-up commit. "CI green + small diff" is not sufficient — always read the bot review first.

## 🚫 Community PR Review Policy (MANDATORY)

A submitted PR is a commitment to a complete, reviewable piece of work. Incomplete PRs slow the project and have caused real incidents (e.g. v10.59.0 merged a partial OAuth fix that required two follow-up patch releases).

### Hard Rules

| Situation | Action |
|-----------|--------|
| PR description is empty or placeholder | CHANGES_REQUESTED — ask author to fill Description + Motivation before any review |
| PR is in Draft status | Do not review or merge. Comment: "Please mark as Ready for Review when complete." |
| PR has TODO / "coming in follow-up" / half-wired code | CHANGES_REQUESTED — no dead code, no deferred wiring (Lean-MCP checklist) |
| We decide to implement the PR ourselves | Trace the **full call path end-to-end**, not just the diff. Every validation layer must be covered. |

### When to redirect to an Issue

If the author cannot complete the implementation, ask them to open an Issue instead:
> "This looks like it needs more work before it's ready to merge. Would you mind opening an Issue describing the problem and your proposed approach? That way the community can help shape the solution."

### Why this exists

- **v10.59.0 incident**: PR #942 (cursor/vscode OAuth schemes) was merged with an empty description. The `ALLOWED_SCHEMES` whitelist change was correct, but `AuthorizationRequest` and `TokenRequest` still used Pydantic `HttpUrl`, silently rejecting `cursor://` before the whitelist was reached. Two follow-up patch releases (v10.59.1, v10.59.2) were needed to actually deliver working Cursor OAuth.
- Root cause: "CI green + looks small" is not sufficient. Full call-path analysis is required.

## 🔀 Merging Multiple PRs That Touch the Same Files

When batch-merging several PRs (e.g. community contributions), conflicts arise if they modify the same file.

### Rules

1. **Order first**: identify which PRs share files (`gh pr diff N --name-only`). Merge the base/largest change first, dependents after.
2. **Verify each merge before proceeding**:
   ```bash
   gh pr view N --repo OWNER/REPO --json state,mergedAt
   # state must be "CLOSED" and mergedAt non-null before moving on
   ```
3. **`gh pr merge --auto` does NOT merge immediately** — it only enables auto-merge. Without CI checks to satisfy, the PR stays open silently. Always verify.
4. **If a PR conflicts after earlier merges**: fetch the branch via `git fetch origin 'refs/pull/N/head:local-branch'`, rebase onto current main, push to a new branch, open a substitute PR, merge it, then close the original with an explanation comment.

**Incident (v10.25.0)**: PRs #557, #558, #560 all touched `sqlite_vec.py`. #557 was "merged" with `--auto` but stayed open. #558 and #562 merged next, causing #557 to conflict. Required manual rebase and two substitute PRs (#562, #563).

### Why This Matters

- **PR #280 lesson**: 7 review iterations, 20 issues found across 7 cycles
- **Root cause**: Quality checks NOT run before PR creation
- **Prevention**: Mandatory pre-PR script catches issues early
- **Time saved**: ~30-60 min per PR vs multi-day review cycles

### PR Template Checklist

See `.github/PULL_REQUEST_TEMPLATE.md` for complete checklist including:
- [ ] Quality gate passed (complexity ≤8, no security issues)
- [ ] All tests passing locally
- [ ] Code-quality-guard agent used
- [ ] Self-reviewed on GitHub diff
