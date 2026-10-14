# Swep - Simplified User Flow

A clean, easy-to-understand diagram showing how Swep works. You can copy the code block below directly into [Excalidraw](https://excalidraw.com) via **More tools > Mermaid to Excalidraw**.

---

## Simple Mermaid Flowchart

```mermaid
flowchart TD
    %% Main Flow
    subgraph S1 ["1. One-time Setup"]
        A["User runs: swep register"] --> B["Encrypt secrets & save to GitHub"]
        B --> C["Get your Login Code"]
    end

    subgraph S2 ["2. Start Session (Any PC)"]
        D["User runs: swep <code>"] --> E["Download & decrypt data from GitHub"]
        E --> F["Launch isolated Chrome with restored session"]
    end

    subgraph S3 ["3. Work Safely"]
        G["Work inside isolated browser<br/>(No history or cookies leak to host PC)"]
        H["Accidentally closed? Run: swep chrome"]
    end

    subgraph S4 ["4. Finish & Clean Up"]
        I["User runs: swep exit"] --> J["Sync updated session to GitHub"]
        J --> K["Delete all local files & wipe history"]
    end

    %% Connections
    C -.->|"Use code anywhere"| D
    F --> G
    G -.-> H
    G --> I
    K --> L(["Clean PC - Zero trace left"])
```

---

## How to Import into Excalidraw
1. Go to [excalidraw.com](https://excalidraw.com).
2. Click **More tools** (top bar).
3. Choose **Mermaid to Excalidraw**.
4. Paste the code above and click **Insert**.
