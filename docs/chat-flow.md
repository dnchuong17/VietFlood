# Chatbot flow

This diagram follows the authenticated `POST /chat` request through the API gateway. Chat history endpoints are shown separately.

```mermaid
flowchart TD
    U[User sends message] --> G[API Gateway: POST /chat]
    G --> A{JWT valid?}
    A -- No --> X[Reject request]
    A -- Yes --> V[Validate body and trim message]
    V --> E{History enabled?}
    E -- No --> X
    E -- Yes --> R[Apply per-user rate limit: 20/min]
    R --> S{Existing sessionId?}
    S -- Yes --> O[Verify session ownership and load recent turns]
    S -- No --> N[Create new session ID]
    O --> D[Handle pending action / classify action intent]
    N --> D
    D --> Q{Action handled?}
    Q -- Yes --> AR[Collect details, read allowlisted data, or preview change]
    AR --> C{Confirmation required?}
    C -- Yes --> P[Return preview and pending action ID]
    C -- No --> H[Save turn to chat history]
    P --> H
    Q -- No --> B{Question type}
    B -- Report status --> RS[Read user's reports from Reports service]
    B -- Reporting instructions --> RG[Return report form guidance]
    B -- Current flood locations --> FL[Read verified flood areas from Reports service]
    B -- Recent report count --> RC[Read verified count from Reports service]
    B -- Small talk --> ST[Return local small-talk reply]
    B -- Other question --> K[Knowledge answer flow]
    K --> F{Reviewed first-aid answer matches?}
    F -- Yes --> FA[Return reviewed first-aid guidance]
    F -- No --> FU{Follow-up question?}
    FU -- Yes --> CTX[Load recent knowledge answers]
    FU -- No --> QS[Search local Qdrant knowledge collection]
    CTX --> QS
    QS --> GM{Gemini configured and approved passages found?}
    GM -- Yes --> LC[LangChain prompt / runnable]
    LC --> GA[ChatGoogle sends grounded prompt to Gemini]
    GM -- No --> LF[Use cleaned local excerpt or out-of-scope reply]
    GA --> H
    LF --> H
    RS --> H
    RG --> H
    FL --> H
    RC --> H
    ST --> H
    FA --> H
    H --> RESP[Return answer, sessionId, and optional action status]

    subgraph Actions[Action confirmation on a later POST /chat]
      P -. User confirms or cancels with actionId .-> DEC{Decision}
      DEC -- Confirm --> EX[Recheck role and execute allowlisted operation]
      DEC -- Cancel --> CAN[Discard pending action]
      EX --> H2[Save result and return completed status]
      CAN --> H2
    end
    subgraph History[Chat history endpoints]
      HL[GET sessions] --> DB[(Encrypted chat history)]
      HM[GET session messages] --> DB
      HD[DELETE session] --> DB
    end
```

## Main response branches

- Actions are parsed with Gemini when configured. Changes are previewed and require explicit confirmation; reads are limited by the allowlist and actor role.
- Status, verified flood-area, and recent verified-count questions read from the Reports service.
- General questions check reviewed first-aid guidance, then search Qdrant. Gemini only receives passages from the approved chat collection; otherwise the answer uses a local excerpt or a scope fallback.
- Each successful reply is stored in the user's chat history before the API returns it. New requests create a session; follow-ups use the existing session ID.

## LangChain

LangChain (`ChatPromptTemplate`, runnables, and `ChatGoogle`) prepares grounded answer prompts and calls Gemini. Action intent extraction also uses LangChain structured output. It only classifies requests: `ChatActionService` continues to enforce the allowlist, role checks, confirmation, and operation execution.
