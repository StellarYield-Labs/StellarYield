# API-backed frontend fetch pattern

API-backed components must not call `getApiBaseUrl()` at module load time. Preview deployments may intentionally omit `VITE_API_BASE_URL`, so resolving the backend URL during import can blank the route before React can render a fallback.

Use `apiUrl()` inside an async action or effect and surface failures with `ApiErrorBanner` or a route-local empty/error state:

```tsx
import { apiUrl } from "../lib/api";
import ApiErrorBanner from "../components/ApiErrorBanner/ApiErrorBanner";

async function loadData() {
  try {
    const response = await fetch(apiUrl("/api/example"));
    if (!response.ok) throw new Error("Unable to load example data");
    return await response.json();
  } catch (error) {
    setError(error instanceof Error ? error.message : "Unable to load example data");
  }
}
```

Same-origin `/api/*` fetches should be reserved for intentional frontend edge routes and documented next to the call site. Backend REST routes should use `apiUrl()` so local development, staging, and production resolve consistently.
