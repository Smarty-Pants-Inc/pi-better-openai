import type { AutocompleteItem } from "@earendil-works/pi-tui";

const TIERS: AutocompleteItem[] = [
  { value: "standard", label: "standard", description: "Use the standard service tier" },
  { value: "fast", label: "fast", description: "Request priority processing" },
  {
    value: "ultrafast",
    label: "ultrafast",
    description: "API-key Astra/Sol only; 6x Standard token prices",
  },
];

function matching(items: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
  const matches = items.filter((item) => item.value.startsWith(prefix));
  return matches.length ? matches : null;
}

export function openAITierArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  return matching(TIERS, prefix.trimStart().toLowerCase());
}
