/**
 * Aggregates all default rule sets for pi-sentinel.
 *
 * Rule ordering is significant: deny rules come before ask rules for the same
 * tool, and scope rules (outside-workspace) come before pattern rules so the
 * most alarming match wins.
 */

import { bashRules } from "./bash";
import { readRules, writeRules, grepRules, findRules, lsRules } from "./paths";
import type { Rule } from "../types";

export function getDefaultRules(): Rule[] {
  return [
    ...bashRules,
    ...readRules,
    ...writeRules,
    ...grepRules,
    ...findRules,
    ...lsRules,
  ];
}
