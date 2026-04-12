/**
 * Core types for Intent Card generation pipeline.
 * Inlined from proactive-ai/src/core/types/intent-card.ts for cloud frontend.
 */

export type GoalBasket = 'work' | 'health' | 'family' | 'wealth' | 'growth' | 'life';

export interface IntentCardAction {
  label: string;
  type: 'confirm' | 'modify' | 'snooze' | 'dismiss';
}

export interface IntentCard {
  id: string;
  goalBasket: GoalBasket;
  title: string;
  whyNow: string;
  summary: string;
  primaryAction: IntentCardAction;
  secondaryActions: IntentCardAction[];
  confidence: number;
  urgency: number;
  importance: number;
  sources: string[];
  agentChain: string[];
  createdAt: string;
}

export interface EvaluationScore {
  cardId: string;
  overall: number;
  dimensions: {
    relevance: number;
    actionability: number;
    whyNowClarity: number;
    novelty: number;
    decisionCompression: number;
  };
  feedback: string;
  pass: boolean;
}

export interface EvaluatorOutput {
  evaluations: EvaluationScore[];
  bestCards: IntentCard[];
  iterationFeedback: string;
}

export type SupportedGenerationLanguage = 'en' | 'zh' | 'ja' | 'ko' | 'es' | 'fr' | 'de';

export const GENERATION_LANGUAGE_OPTIONS: { value: SupportedGenerationLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];
