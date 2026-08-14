import { describe, expect, test } from 'vitest'
import {
  assertFreshQueriesDoNotOverlapHistory,
  planAcceptedGroupRebalance,
  selectDiversePendingCandidates,
} from '../../src/evaluation/vlm-blind-candidate-diversity.js'

describe('Phase F pending candidate diversity', () => {
  test('rebalances accepted surplus with new pending candidates without rewriting parents', () => {
    const plan = planAcceptedGroupRebalance({
      targetPerGroup: 1,
      parents: [
        { caseId: 'surplus-1', currentGroup: 'missing_must_have', runId: 'run', queryId: 'q1' },
        { caseId: 'surplus-2', currentGroup: 'missing_must_have', runId: 'run', queryId: 'q2' },
        { caseId: 'kept', currentGroup: 'missing_must_have', runId: 'run', queryId: 'q3' },
        { caseId: 'surplus-3', currentGroup: 'missing_must_have', runId: 'run', queryId: 'q4' },
        { caseId: 'surplus-4', currentGroup: 'missing_must_have', runId: 'run', queryId: 'q5' },
      ],
      candidates: [
        {
          candidateId: 'c1',
          runId: 'run',
          queryId: 'q1',
          eligibleGroups: ['exact_match'],
          stableOrder: '1',
        },
        {
          candidateId: 'c2',
          runId: 'run',
          queryId: 'q2',
          eligibleGroups: ['exclusion_hit'],
          stableOrder: '2',
        },
        {
          candidateId: 'c3',
          runId: 'run',
          queryId: 'q4',
          eligibleGroups: ['partial_relevance'],
          stableOrder: '3',
        },
        {
          candidateId: 'c4',
          runId: 'run',
          queryId: 'q5',
          eligibleGroups: ['insufficient_evidence'],
          stableOrder: '4',
        },
      ],
    })
    expect(plan).toHaveLength(4)
    expect(new Set(plan.map((item) => item.targetGroup))).toEqual(
      new Set(['exact_match', 'exclusion_hit', 'partial_relevance', 'insufficient_evidence']),
    )
  })

  test('rejects overlap with any historical Evaluation query, not only reviewed cases', () => {
    expect(() =>
      assertFreshQueriesDoNotOverlapHistory(
        new Set(['brand new query', 'old but never reviewed query']),
        ['another historical query', 'old but never reviewed query'],
      ),
    ).toThrow('fresh Evaluation run overlaps 1 historical query texts')
  })

  test('preserves reviewed identities while maximizing new queries and capping repeats at two', () => {
    const selected = selectDiversePendingCandidates({
      slots: [
        { proposalId: 'pending-1', group: 'partial_relevance' },
        { proposalId: 'pending-2', group: 'partial_relevance' },
        { proposalId: 'pending-3', group: 'exclusion_hit' },
      ],
      reviewedCandidateIds: new Set(['reviewed-candidate']),
      reviewedQueryTexts: ['reviewed query'],
      candidates: [
        {
          candidateId: 'reviewed-candidate',
          queryText: 'must stay reviewed',
          eligibleGroups: ['partial_relevance'],
          stableOrder: '00',
        },
        {
          candidateId: 'new-a',
          queryText: 'new query A',
          eligibleGroups: ['partial_relevance', 'exclusion_hit'],
          stableOrder: '01',
        },
        {
          candidateId: 'new-b',
          queryText: 'new query B',
          eligibleGroups: ['partial_relevance'],
          stableOrder: '02',
        },
        {
          candidateId: 'new-a-second',
          queryText: 'new query A',
          eligibleGroups: ['exclusion_hit'],
          stableOrder: '03',
        },
      ],
      minimumUniqueQueries: 3,
    })

    expect([...selected.values()].map((item) => item.candidateId)).not.toContain(
      'reviewed-candidate',
    )
    expect(new Set([...selected.values()].map((item) => item.queryText))).toEqual(
      new Set(['new query A', 'new query B']),
    )
    expect([...selected.values()].filter((item) => item.queryText === 'new query A')).toHaveLength(
      2,
    )
  })

  test('fails instead of silently exceeding the requested query cap', () => {
    expect(() =>
      selectDiversePendingCandidates({
        slots: [
          { proposalId: 'pending-1', group: 'partial_relevance' },
          { proposalId: 'pending-2', group: 'partial_relevance' },
        ],
        reviewedCandidateIds: new Set(),
        reviewedQueryTexts: ['only query'],
        candidates: [
          {
            candidateId: 'candidate-1',
            queryText: 'only query',
            eligibleGroups: ['partial_relevance'],
            stableOrder: '01',
          },
          {
            candidateId: 'candidate-2',
            queryText: 'only query',
            eligibleGroups: ['partial_relevance'],
            stableOrder: '02',
          },
        ],
        minimumUniqueQueries: 1,
      }),
    ).toThrow(/no capped candidate remains/)
  })

  test('can require every pending slot to use a different fresh query', () => {
    expect(() =>
      selectDiversePendingCandidates({
        slots: [
          { proposalId: 'pending-1', group: 'partial_relevance' },
          { proposalId: 'pending-2', group: 'partial_relevance' },
        ],
        reviewedCandidateIds: new Set(),
        reviewedQueryTexts: [],
        candidates: [
          {
            candidateId: 'candidate-1',
            queryText: 'fresh query A',
            eligibleGroups: ['partial_relevance'],
            stableOrder: '01',
          },
          {
            candidateId: 'candidate-2',
            queryText: 'fresh query A',
            eligibleGroups: ['partial_relevance'],
            stableOrder: '02',
          },
        ],
        minimumUniqueQueries: 2,
        maxPairsPerQuery: 1,
      }),
    ).toThrow(/no capped candidate remains/)
  })
})
