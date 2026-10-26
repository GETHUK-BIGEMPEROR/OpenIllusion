import { QueryClient } from "@tanstack/react-query";
import type { EngineInfo } from "./api";

/** The app's one query client, so code outside components (drops, the store) can read what's loaded. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 5_000 } },
});

export const cachedEngine = (id: string) => queryClient.getQueryData<EngineInfo[]>(["engines"])?.find((e) => e.id === id);
