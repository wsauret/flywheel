export const DRAFT_JSON_EXAMPLE = `{
  "steps": [
    {
      "title": "Create server module with Bun.serve()",
      "description": "Implement GET /hello endpoint returning JSON {greeting, timestamp}. Bind to 127.0.0.1:3000. Use Bun.serve() API with fetch handler.",
      "acceptanceCriteria": [
        "GET /hello returns 200 with JSON body containing greeting and timestamp",
        "Server binds to 127.0.0.1:3000",
        "Response Content-Type is application/json"
      ],
      "fileReferences": ["src/server/index.ts", "tests/server.test.ts"],
      "feature": "server",
      "fulfills": ["BC-SERVER-001", "BC-SERVER-002"],
      "milestone": "Foundation",
      "estimatedComplexity": "low"
    }
  ],
  "behavioralContract": [
    {
      "id": "BC-SERVER-001",
      "title": "Hello endpoint returns greeting",
      "description": "GET /hello returns 200 with JSON body containing a greeting string and ISO timestamp",
      "evidence": "curl http://localhost:3000/hello returns 200, body has greeting and timestamp fields",
      "area": "Server"
    }
  ],
  "decisions": [
    "Using Bun.serve() native API instead of Express for zero-dependency server"
  ],
  "risks": [
    "Port 3000 may conflict with other services"
  ]
}`;

export const ANNOTATED_JSON_EXAMPLE = `{
  "steps": [
    {
      "title": "Original title (DO NOT MODIFY)",
      "description": "Original description (DO NOT MODIFY)",
      "acceptanceCriteria": ["Original (DO NOT MODIFY)"],
      "fileReferences": ["Original (DO NOT MODIFY)"],
      "feature": "original",
      "fulfills": ["BC-AREA-001"],
      "review": {
        "findings": [
          {
            "severity": "P1",
            "description": "Must bind to 127.0.0.1, not 0.0.0.0",
            "reviewer": "security",
            "actionRequired": "Add explicit host binding"
          }
        ]
      }
    }
  ],
  "behavioralContract": [
    {
      "id": "BC-AREA-001",
      "title": "DO NOT MODIFY",
      "description": "DO NOT MODIFY",
      "evidence": "DO NOT MODIFY",
      "area": "DO NOT MODIFY"
    }
  ],
  "decisions": ["DO NOT MODIFY"],
  "risks": ["DO NOT MODIFY"],
  "openQuestions": [
    {
      "question": "Should server.enabled default to true or false?",
      "raisedBy": "scope",
      "options": ["true (simpler)", "false (safer)"]
    }
  ]
}`;

export const CLEAN_JSON_EXAMPLE = `{
  "steps": [
    {
      "title": "Create server module with Bun.serve()",
      "description": "Implement GET /hello endpoint. Bind to 127.0.0.1:3000 (per security review).",
      "acceptanceCriteria": [
        "GET /hello returns 200 with JSON body",
        "Server binds to 127.0.0.1:3000 (not 0.0.0.0)"
      ],
      "fileReferences": ["src/server/index.ts", "tests/server.test.ts"],
      "feature": "server",
      "fulfills": ["BC-SERVER-001"],
      "milestone": "Foundation",
      "estimatedComplexity": "low"
    }
  ],
  "behavioralContract": [
    {
      "id": "BC-SERVER-001",
      "title": "Hello endpoint returns greeting",
      "description": "GET /hello returns 200 with greeting and timestamp",
      "evidence": "curl http://localhost:3000/hello returns 200",
      "area": "Server"
    }
  ],
  "decisions": [
    "Using Bun.serve() native API",
    "Bind to 127.0.0.1 per security review"
  ],
  "risks": [
    "Port 3000 may conflict with other services"
  ]
}`;
