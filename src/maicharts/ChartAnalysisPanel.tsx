import { Badge, Card, Group, Progress, SimpleGrid, Stack, Text } from '@mantine/core';
import type { ChartAnalysis } from './data';

/** 特征强度 → 颜色 */
function strengthColor(strength: number | undefined): string {
  if (strength === undefined) return 'gray';
  if (strength >= 10) return 'red';
  if (strength >= 5) return 'orange';
  return 'gray';
}

const CLASSIFICATION_COLOR: Record<string, string> = {
  normal: 'green',
  water: 'blue',
  fake: 'orange',
};

function formatNumber(n: number | undefined, digits = 1): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '-';
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

/**
 * 谱面分析（来自 AWMC chart-preview API 的 configAnalysis 快照）。
 * 数据由定时同步任务写入 `public/data/analysis/*.json`。
 */
export function ChartAnalysisPanel({ analysis }: { analysis: ChartAnalysis | null }) {
  if (!analysis?.configAnalysis) return null;

  const ca = analysis.configAnalysis;
  const classification = ca.difficultyTag;
  const radar = (ca.radarAxes ?? []).filter((a) => a.score > 0).slice(0, 5);
  const patterns = (ca.patterns ?? []).slice(0, 6);

  return (
    <Card radius="lg" withBorder>
      <Group justify="space-between" align="center" mb="xs">
        <Text size="sm" fw={600}>
          谱面分析
        </Text>
        <Badge size="xs" variant="light" color="grape">
          AWMC API
        </Badge>
      </Group>

      {classification ? (
        <Group gap="xs" mb="xs" wrap="wrap">
          <Badge
            size="sm"
            variant="light"
            color={classification.color ?? CLASSIFICATION_COLOR[classification.tag ?? ''] ?? 'gray'}
          >
            {classification.label ?? classification.tag ?? '难度分类'}
          </Badge>
          {classification.estimatedLevel !== undefined ? (
            <Text size="xs" c="dimmed">
              模型估计 {formatNumber(classification.estimatedLevel, 2)}
              {classification.deviation !== undefined
                ? `（偏差 ${classification.deviation >= 0 ? '+' : ''}${formatNumber(classification.deviation, 2)}）`
                : ''}
            </Text>
          ) : null}
        </Group>
      ) : null}

      <SimpleGrid cols={2} spacing={6} verticalSpacing={4} mb="xs">
        <Text size="xs" c="dimmed">
          物量 <Text component="span" size="xs" c="var(--mantine-color-text)">{ca.totalNotes ?? '-'}</Text>
        </Text>
        <Text size="xs" c="dimmed">
          平均/峰值 NPS{' '}
          <Text component="span" size="xs" c="var(--mantine-color-text)">
            {formatNumber(ca.averageNps, 2)} / {formatNumber(ca.peakNps, 2)}
          </Text>
        </Text>
        <Text size="xs" c="dimmed">
          Tap/Hold/Slide/Break{' '}
          <Text component="span" size="xs" c="var(--mantine-color-text)">
            {ca.tapCount ?? '-'}/{ca.holdCount ?? '-'}/{ca.slideCount ?? '-'}/{ca.breakCount ?? '-'}
          </Text>
        </Text>
        <Text size="xs" c="dimmed">
          时长{' '}
          <Text component="span" size="xs" c="var(--mantine-color-text)">
            {ca.durationSeconds !== undefined ? `${formatNumber(ca.durationSeconds, 0)}s` : '-'}
          </Text>
        </Text>
      </SimpleGrid>

      {radar.length > 0 ? (
        <Stack gap={4} mb="xs">
          {radar.map((axis) => (
            <Group key={axis.label} gap="xs" wrap="nowrap">
              <Text size="xs" w={52} style={{ flexShrink: 0 }} lineClamp={1}>
                {axis.label}
              </Text>
              <Progress value={Math.min(100, axis.score)} size="xs" style={{ flex: 1 }} />
              <Text size="xs" c="dimmed" w={28} ta="right">
                {axis.score}
              </Text>
            </Group>
          ))}
        </Stack>
      ) : null}

      {patterns.length > 0 ? (
        <Group gap={4} wrap="wrap">
          {patterns.map((p, i) => (
            <Badge
              key={`${p.label}-${i}`}
              size="xs"
              variant="outline"
              color={strengthColor(p.strength)}
              title={p.details}
            >
              {p.label}
              {p.strength !== undefined ? ` ${p.strength}` : ''}
            </Badge>
          ))}
        </Group>
      ) : null}
    </Card>
  );
}
