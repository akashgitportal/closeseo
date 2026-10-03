export type Scope = "exact_url" | "subfolder" | "domain" | "subdomains";

export type KeywordRow = {
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: string | null;
  monthlySearches?: { year: number; month: number; searchVolume: number }[];
  clickstream?: { searchVolume: number | null } | null;
  [k: string]: unknown;
};
