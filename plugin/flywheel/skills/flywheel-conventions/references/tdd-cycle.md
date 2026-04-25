# TDD Cycle

Red-Green-Refactor cycle applied per implementation task within each phase.

## Per Implementation Task

### 1. RED: Write Failing Test First

- One test, one behavior
- Run tests - confirm FAILS for expected reason (not syntax error)
- If passes immediately: test is wrong, rewrite

### 2. GREEN: Implement Minimal Code

- Simplest code to pass the test
- No extras, no optimization
- Run tests - confirm PASSES

### 3. REFACTOR: Clean Up (Optional)

- Remove duplication, improve names
- Run tests after each change

## Skip TDD When

- Pure refactoring (tests already exist)
- Config-only changes
- Security-sensitive configurations (auth, CORS, CSP, encryption) are NOT exempt — these require test coverage even when config-only
- Documentation updates
