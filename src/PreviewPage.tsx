import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import type { ChangeEvent } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Container,
  Group,
  Image,
  Kbd,
  Loader,
  ScrollArea,
  SimpleGrid,
  Stack,
  Stepper,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconLock, IconLockOpen, IconSearch, IconX } from '@tabler/icons-react';
import { ChartCanvas } from './chart/components/ChartCanvas';
import { Controls, PlaybackControls } from './chart/components/Controls';
import { useGameStore } from './chart/stores/useGameStore';
import { useGameSettingsStore } from './chart/stores/useGameSettingsStore';
import { getAvailableDifficulties, parseSimaiChart } from './chart/core/parser/ChartParser';
import { DIFFICULTY_COLORS, DIFFICULTY_NAMES, type ChartDifficulty } from './chart/types';
import { lxnsJacketWebpUrl } from './lxns/assets';
import type { LxnsSong, LxnsSongListResponse } from './lxns/types';
import { chartFileIdForSong, fetchSimaiText, musicMp3UrlForChartFileId, type ChartKind } from './lxns/chartResolve';
import { buildPreviewUrlParams, parsePreviewUrlParams } from './previewUrlParams';
import classes from './preview-chart.module.css';

export type ChartPick = {
  song: LxnsSong;
  kind: ChartKind;
  chartFileId: number;
  chartDifficulty: ChartDifficulty;
  label: string;
};

function pickKey(p: ChartPick): string {
  return `${p.song.id}-${p.kind}-${p.chartDifficulty}`;
}

/** 根据背景色亮度返回黑/白文字，避免浅底配白字（如 Re:MASTER） */
function contrastingTextForHexBackground(bgHex: string): string {
  const h = bgHex.replace('#', '').trim();
  if (h.length !== 6) return '#ffffff';
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.55 ? '#0f172a' : '#ffffff';
}

function buildPicksForSong(song: LxnsSong): ChartPick[] {
  const picks: ChartPick[] = [];

  for (const row of song.difficulties.standard ?? []) {
    const kind: ChartKind = 'standard';
    const chartFileId = chartFileIdForSong(song.id, kind);
    const cd = (row.difficulty + 2) as ChartDifficulty;
    picks.push({
      song,
      kind,
      chartFileId,
      chartDifficulty: cd,
      label: `标准 · ${DIFFICULTY_NAMES[cd]} ${row.level}`,
    });
  }

  for (const row of song.difficulties.dx ?? []) {
    const kind: ChartKind = 'dx';
    const chartFileId = chartFileIdForSong(song.id, kind);
    const cd = (row.difficulty + 2) as ChartDifficulty;
    picks.push({
      song,
      kind,
      chartFileId,
      chartDifficulty: cd,
      label: `DX · ${DIFFICULTY_NAMES[cd]} ${row.level}`,
    });
  }

  for (const row of song.difficulties.utage ?? []) {
    const kind: ChartKind = 'utage';
    const chartFileId = chartFileIdForSong(song.id, kind);
    const cd = (row.difficulty + 2) as ChartDifficulty;
    const tag = row.kanji ? `「${row.kanji}」` : '宴会场';
    picks.push({
      song,
      kind,
      chartFileId,
      chartDifficulty: cd,
      label: `宴会 ${tag} ${row.level}`,
    });
  }

  return picks;
}

function SongJacket({ songId, size = 52 }: { songId: number; size?: number }) {
  const [broken, setBroken] = useState(false);
  const dim = size;
  if (broken) {
    return (
      <Box
        w={dim}
        h={dim}
        style={{
          borderRadius: 8,
          background: 'var(--mantine-color-dark-5)',
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <Image
      w={dim}
      h={dim}
      radius="sm"
      fit="cover"
      src={lxnsJacketWebpUrl(songId)}
      alt=""
      onError={() => setBroken(true)}
      style={{ flexShrink: 0 }}
    />
  );
}

function songSummaryLine(s: LxnsSong, versionTitlesByCode: Map<number, string>): string {
  const parts: string[] = [];
  if (s.genre) parts.push(s.genre);
  if (s.bpm > 0) parts.push(`BPM ${s.bpm}`);
  const verTitle = versionTitlesByCode.get(s.version);
  if (verTitle) parts.push(verTitle);
  else parts.push(`版本号 ${s.version}`);
  return parts.join(' · ');
}

function KeyboardShortcuts() {
  return (
    <Card radius="lg" withBorder>
      <Text size="sm" fw={500} mb="sm">
        键盘快捷键
      </Text>
      <SimpleGrid cols={2} spacing="xs">
        <Group justify="space-between">
          <Kbd>Space</Kbd>
          <Text size="xs" c="dimmed">
            播放/暂停
          </Text>
        </Group>
        <Group justify="space-between">
          <Kbd>R</Kbd>
          <Text size="xs" c="dimmed">
            重新播放当前小节
          </Text>
        </Group>
        <Group justify="space-between">
          <Kbd>← →</Kbd>
          <Text size="xs" c="dimmed">
            步进
          </Text>
        </Group>
        <Group justify="space-between">
          <Kbd>↑ ↓</Kbd>
          <Text size="xs" c="dimmed">
            流速
          </Text>
        </Group>
      </SimpleGrid>
    </Card>
  );
}

function useKeyboardShortcuts() {
  const togglePlayback = useGameStore((s) => s.togglePlayback);
  const restart = useGameStore((s) => s.restart);
  const stepMeasure = useGameStore((s) => s.stepMeasure);
  const stepPosition = useGameStore((s) => s.stepPosition);
  const setHiSpeed = useGameSettingsStore((s) => s.setHiSpeed);
  const hiSpeed = useGameSettingsStore((s) => s.hiSpeed);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlayback();
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          restart();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) stepMeasure(-1);
          else stepPosition(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) stepMeasure(1);
          else stepPosition(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHiSpeed(Math.min(9, hiSpeed + 0.25));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setHiSpeed(Math.max(3, hiSpeed - 0.25));
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlayback, restart, stepMeasure, stepPosition, setHiSpeed, hiSpeed]);
}

const MAX_RESULTS = 60;

export default function PreviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [queryInput, setQueryInput] = useState('');
  const deferredQuery = useDeferredValue(queryInput);
  const [songs, setSongs] = useState<LxnsSong[]>([]);
  const [versionTitlesByCode, setVersionTitlesByCode] = useState<Map<number, string>>(() => new Map());
  const [aliasById, setAliasById] = useState<Map<number, string[]>>(new Map());
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);

  const [selectedSong, setSelectedSong] = useState<LxnsSong | null>(null);
  const [pick, setPick] = useState<ChartPick | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);

  const reset = useGameStore((s) => s.reset);
  const setRawSimaiText = useGameStore((s) => s.setRawSimaiText);
  const setMusicUrl = useGameStore((s) => s.setMusicUrl);
  const setChartData = useGameStore((s) => s.setChartData);
  const setAvailableDifficulties = useGameStore((s) => s.setAvailableDifficulties);
  const setSelectedDifficulty = useGameStore((s) => s.setSelectedDifficulty);
  const chartData = useGameStore((s) => s.chartData);
  const isFullscreen = useGameStore((s) => s.isFullscreen);
  const toggleFullscreen = useGameStore((s) => s.toggleFullscreen);
  const setIsFullscreen = useGameStore((s) => s.setIsFullscreen);
  const bumpMusicSession = useGameStore((s) => s.bumpMusicSession);

  const [wizardStep, setWizardStep] = useState(0);
  const [stepperHeaderExpanded, setStepperHeaderExpanded] = useState(true);
  /** 进入预览步时首帧跳过步骤条过渡（保持瞬间收起）；手动收起仍走动画 */
  const [stepperCollapseWithoutMotion, setStepperCollapseWithoutMotion] = useState(false);
  const prevWizardStepRef = useRef(wizardStep);

  const [showControls, setShowControls] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chartCanvasRef = useRef<HTMLDivElement>(null);
  const fullscreenElementRef = useRef<HTMLDivElement>(null);

  useKeyboardShortcuts();

  /** 地址栏 → 状态：在写入 URL 的 effect 之前同步，避免首屏用空状态冲掉分享链接 */
  useLayoutEffect(() => {
    if (catalogLoading || catalogError || songs.length === 0) return;

    const { songId, kind, diff } = parsePreviewUrlParams(searchParams);
    if (songId === null) return;

    const song = songs.find((s) => s.id === songId);
    if (!song) return;

    setSelectedSong((prev) => (prev?.id === song.id ? prev : song));

    if (kind !== null && diff !== null) {
      const picks = buildPicksForSong(song);
      const match = picks.find((p) => p.kind === kind && p.chartDifficulty === diff);
      if (match) {
        setPick(match);
        setWizardStep(2);
      }
    }
  }, [searchParams, catalogLoading, catalogError, songs]);

  /** 状态 → 地址栏：选中曲目记 `song`；进入预览步再记 `kind` + `diff`（乐曲难度） */
  useEffect(() => {
    if (catalogLoading || catalogError) return;

    const next = buildPreviewUrlParams({
      songId: selectedSong?.id ?? null,
      kind: wizardStep === 2 && pick ? pick.kind : null,
      diff: wizardStep === 2 && pick ? pick.chartDifficulty : null,
    });

    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [selectedSong, wizardStep, pick, catalogLoading, catalogError, searchParams, setSearchParams]);

  useEffect(() => {
    const prev = prevWizardStepRef.current;
    prevWizardStepRef.current = wizardStep;
    if (wizardStep === 2 && prev !== 2 && pick) {
      bumpMusicSession();
    }
    if (wizardStep === 2 && prev !== 2) {
      setStepperHeaderExpanded(false);
      setStepperCollapseWithoutMotion(true);
    } else if (wizardStep !== 2) {
      setStepperHeaderExpanded(true);
      setStepperCollapseWithoutMotion(false);
    }
  }, [wizardStep, pick, bumpMusicSession]);

  useLayoutEffect(() => {
    if (!stepperCollapseWithoutMotion) return;
    setStepperCollapseWithoutMotion(false);
  }, [stepperCollapseWithoutMotion]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [aliasRes, songRes] = await Promise.all([
          fetch('https://maimai.lxns.net/api/v0/maimai/alias/list'),
          fetch('https://maimai.lxns.net/api/v0/maimai/song/list'),
        ]);
        if (!aliasRes.ok || !songRes.ok) throw new Error('bad status');
        const aliasJson = (await aliasRes.json()) as { aliases: { song_id: number; aliases: string[] }[] };
        const songJson = (await songRes.json()) as LxnsSongListResponse;
        if (cancelled) return;
        const m = new Map<number, string[]>();
        for (const e of aliasJson.aliases) m.set(e.song_id, e.aliases);
        setAliasById(m);
        setSongs(songJson.songs);
        const vMap = new Map<number, string>();
        for (const v of songJson.versions ?? []) {
          vMap.set(v.version, v.title);
        }
        setVersionTitlesByCode(vMap);
      } catch {
        if (!cancelled) setCatalogError('无法加载曲目或别名数据，请检查网络后刷新页面。');
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const haystackBySongId = useMemo(() => {
    const map = new Map<number, string>();
    for (const song of songs) {
      const aliases = aliasById.get(song.id) ?? [];
      const blob = [String(song.id), song.title, song.artist, ...aliases].join(' ').toLowerCase();
      map.set(song.id, blob);
    }
    return map;
  }, [songs, aliasById]);

  const filteredSongs = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return [];

    if (/^\d+$/.test(q)) {
      const id = parseInt(q, 10);
      const hit = songs.find((s) => s.id === id);
      if (hit) return [hit];
    }

    const out: LxnsSong[] = [];
    for (const song of songs) {
      const h = haystackBySongId.get(song.id) ?? '';
      if (h.includes(q)) {
        out.push(song);
        if (out.length >= MAX_RESULTS) break;
      }
    }
    return out;
  }, [deferredQuery, songs, haystackBySongId]);

  const loadChartForPick = useCallback(
    async (p: ChartPick, signal: AbortSignal) => {
      setChartError(null);
      const nextMusicUrl = musicMp3UrlForChartFileId(p.chartFileId);
      const prevUrl = useGameStore.getState().musicUrl;
      if (prevUrl !== nextMusicUrl) {
        setMusicUrl(nextMusicUrl);
      }

      const simai = await fetchSimaiText(p.chartFileId);
      if (signal.aborted) return;
      if (!simai) {
        setChartError(`未找到谱面文件（chart ${p.chartFileId}）。该曲目可能没有对应类型的谱面数据。`);
        setRawSimaiText('');
        setChartData(null);
        setAvailableDifficulties({});
        return;
      }

      setRawSimaiText(simai);
      try {
        const available = getAvailableDifficulties(simai);
        setAvailableDifficulties(available);

        let diffToUse = p.chartDifficulty;
        if (!available[diffToUse]) {
          const availableList = Object.keys(available)
            .map(Number)
            .sort((a, b) => b - a) as ChartDifficulty[];
          diffToUse = (availableList[0] ?? diffToUse) as ChartDifficulty;
        }

        setSelectedDifficulty(diffToUse);
        const chart = parseSimaiChart(simai, diffToUse);
        if (signal.aborted) return;
        setChartData(chart);
      } catch (e) {
        console.error(e);
        if (!signal.aborted) setChartError('解析谱面失败。');
      }
    },
    [setMusicUrl, setRawSimaiText, setChartData, setAvailableDifficulties, setSelectedDifficulty]
  );

  useEffect(() => {
    if (!pick) {
      reset();
      setChartError(null);
      return;
    }

    const ac = new AbortController();
    loadChartForPick(pick, ac.signal);
    return () => ac.abort();
  }, [pick, reset, loadChartForPick]);

  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  useEffect(() => {
    if (!isFullscreen) {
      setShowControls(true);
      setIsLocked(false);
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
      return;
    }

    if (isLocked) {
      setShowControls(false);
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
      return;
    }

    let lastTouchTime = 0;
    let isOverControls = false;

    const showControlsWithTimeout = () => {
      setShowControls(true);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
      if (!isOverControls) {
        controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const wasOverControls = isOverControls;
      isOverControls = !!(
        target.closest('.mantine-ActionIcon-root') ||
        target.closest('[class*="fullscreenControls"]')
      );

      if (isOverControls) {
        if (controlsTimeoutRef.current) {
          clearTimeout(controlsTimeoutRef.current);
          controlsTimeoutRef.current = null;
        }
        if (!wasOverControls) setShowControls(true);
      } else {
        showControlsWithTimeout();
      }
    };

    const handleTouch = (e: TouchEvent) => {
      const now = Date.now();
      if (now - lastTouchTime < 300) return;
      lastTouchTime = now;

      const target = e.target as HTMLElement;
      const isTouchingControls = !!(
        target.closest('[class*="fullscreenControls"]') ||
        target.closest('.mantine-ActionIcon-root')
      );

      if (isTouchingControls) {
        setShowControls(true);
        if (controlsTimeoutRef.current) {
          clearTimeout(controlsTimeoutRef.current);
          controlsTimeoutRef.current = null;
        }
        isOverControls = true;
      } else {
        e.preventDefault();
        isOverControls = false;
        setShowControls((prev) => {
          if (prev) {
            if (controlsTimeoutRef.current) {
              clearTimeout(controlsTimeoutRef.current);
              controlsTimeoutRef.current = null;
            }
            return false;
          }
          if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
          controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
          return true;
        });
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchstart', handleTouch, { passive: false });
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchstart', handleTouch);
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
    };
  }, [isFullscreen, isLocked]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const doc = document as Document & {
        webkitFullscreenElement?: Element;
        mozFullScreenElement?: Element;
        msFullscreenElement?: Element;
      };
      const isCurrentlyFullscreen = !!(
        document.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement
      );
      if (isFullscreen && !isCurrentlyFullscreen) setIsFullscreen(false);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, [isFullscreen, setIsFullscreen]);

  useEffect(() => {
    const element = fullscreenElementRef.current;
    if (!element) return;

    const enterFullscreen = async () => {
      try {
        const el = element as HTMLElement & {
          webkitRequestFullscreen?: () => Promise<void>;
          mozRequestFullScreen?: () => Promise<void>;
          msRequestFullscreen?: () => Promise<void>;
        };
        if (element.requestFullscreen) await element.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
        else if (el.mozRequestFullScreen) await el.mozRequestFullScreen();
        else if (el.msRequestFullscreen) await el.msRequestFullscreen();
      } catch (err) {
        console.error('全屏失败:', err);
      }
    };

    const exitFullscreen = async () => {
      try {
        const doc = document as Document & {
          webkitExitFullscreen?: () => Promise<void>;
          mozCancelFullScreen?: () => Promise<void>;
          msExitFullscreen?: () => Promise<void>;
        };
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
        else if (doc.mozCancelFullScreen) await doc.mozCancelFullScreen();
        else if (doc.msExitFullscreen) await doc.msExitFullscreen();
      } catch (err) {
        console.error('退出全屏失败:', err);
      }
    };

    if (isFullscreen) void enterFullscreen();
    else void exitFullscreen();
  }, [isFullscreen]);

  useEffect(() => {
    const chartCanvasElement = chartCanvasRef.current;
    if (!chartCanvasElement) return;
    const fullscreenContainer = document.getElementById('fullscreen-chart-container');
    const normalContainer = document.getElementById('normal-chart-container');
    if (isFullscreen && fullscreenContainer) fullscreenContainer.appendChild(chartCanvasElement);
    else if (!isFullscreen && normalContainer) normalContainer.appendChild(chartCanvasElement);
  }, [isFullscreen]);

  const songPicks = selectedSong ? buildPicksForSong(selectedSong) : [];

  const goToStep = useCallback(
    (next: number) => {
      if (next === 0) {
        setPick(null);
        setWizardStep(0);
        return;
      }
      if (next === 1 && selectedSong) {
        setWizardStep(1);
        return;
      }
      if (next === 2 && pick) setWizardStep(2);
    },
    [selectedSong, pick]
  );

  return (
    <>
      <Container size="xl" py="lg" style={{ display: isFullscreen ? 'none' : 'block' }}>
        <Stack gap="lg">
          <div>
            <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
              <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                <Group gap="xs" wrap="wrap">
                  <Title order={2}>舞萌谱面预览</Title>
                  <Badge variant="light" color="blue">
                    独立页
                  </Badge>
                </Group>
                <Text size="sm" c="dimmed">
                  数据来自：maimai.lxns.net
                </Text>
              </Stack>
              {wizardStep === 2 ? (
                <UnstyledButton
                  type="button"
                  onClick={() => setStepperHeaderExpanded((v) => !v)}
                  aria-expanded={stepperHeaderExpanded}
                  aria-label={stepperHeaderExpanded ? '收起步骤向导' : '展开步骤向导'}
                  title={stepperHeaderExpanded ? '收起步骤向导' : '展开步骤向导'}
                  style={{
                    flexShrink: 0,
                    alignSelf: 'flex-start',
                    marginTop: 2,
                    padding: '4px 10px',
                    borderRadius: 'var(--mantine-radius-md)',
                    border: '1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))',
                    background: 'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))',
                  }}
                >
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" c="dimmed" fw={500}>
                      {stepperHeaderExpanded ? '收起' : '步骤'}
                    </Text>
                    {stepperHeaderExpanded ? (
                      <IconChevronUp size={16} stroke={1.75} />
                    ) : (
                      <IconChevronDown size={16} stroke={1.75} />
                    )}
                  </Group>
                </UnstyledButton>
              ) : null}
            </Group>
          </div>

          <Stepper
            active={wizardStep}
            onStepClick={goToStep}
            allowNextStepsSelect={false}
            keepMounted
            mb="md"
            classNames={{
              steps: clsx(
                wizardStep === 2 &&
                  (stepperHeaderExpanded
                    ? classes.stepperStepsExpanded
                    : stepperCollapseWithoutMotion
                      ? classes.stepperStepsCollapsedInstant
                      : classes.stepperStepsCollapsedAnimated)
              ),
            }}
          >
            <Stepper.Step label="曲目" description="搜索并选择">
              <Card withBorder radius="md" padding="md" mt="md">
                <Stack gap="sm">
                  <TextInput
                    label="搜索曲目"
                    description="支持曲名、艺术家、别名、曲目 ID（纯数字精确匹配）"
                    placeholder="例如：真爱、海百合、417、True Love"
                    leftSection={<IconSearch size={18} />}
                    rightSection={
                      queryInput ? (
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="gray"
                          aria-label="清空搜索"
                          onClick={() => setQueryInput('')}
                        >
                          <IconX size={16} />
                        </ActionIcon>
                      ) : null
                    }
                    rightSectionPointerEvents={queryInput ? 'all' : undefined}
                    value={queryInput}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setQueryInput(e.currentTarget.value)}
                  />
                  {catalogLoading && (
                    <Group gap="xs">
                      <Loader size="sm" />
                      <Text size="sm">正在加载曲目与别名…</Text>
                    </Group>
                  )}
                  {catalogError && (
                    <Alert color="red" title="加载失败">
                      {catalogError}
                    </Alert>
                  )}
                  {!catalogLoading && !catalogError && (
                    filteredSongs.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        {queryInput.trim() ? '无匹配结果' : '输入关键词开始搜索'}
                      </Text>
                    ) : (
                      <ScrollArea.Autosize w="100%" mah={320} type="auto" offsetScrollbars scrollbars="y">
                        <Stack gap={4}>
                          {filteredSongs.map((s) => (
                            <UnstyledButton
                              key={s.id}
                              onClick={() => {
                                setSelectedSong(s);
                                setPick(null);
                              }}
                              style={{
                                textAlign: 'left',
                                padding: '8px 10px',
                                borderRadius: 8,
                                background:
                                  selectedSong?.id === s.id
                                    ? 'var(--mantine-color-blue-light)'
                                    : 'var(--mantine-color-default-hover)',
                              }}
                            >
                              <Group gap="sm" wrap="nowrap" align="flex-start">
                                <SongJacket songId={s.id} size={52} />
                                <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                                  <Text size="sm" fw={600} lineClamp={2}>
                                    {s.title}{' '}
                                    <Text component="span" c="dimmed" size="xs" ff="monospace">
                                      #{s.id}
                                    </Text>
                                  </Text>
                                  <Text size="xs" c="dimmed" lineClamp={1}>
                                    {s.artist}
                                    {(aliasById.get(s.id)?.length ?? 0) > 0
                                      ? ` · 别名：${(aliasById.get(s.id) ?? []).slice(0, 4).join(' / ')}`
                                      : ''}
                                  </Text>
                                  <Text size="xs" c="dimmed" lineClamp={2}>
                                    {songSummaryLine(s, versionTitlesByCode)}
                                  </Text>
                                </Stack>
                              </Group>
                            </UnstyledButton>
                          ))}
                        </Stack>
                      </ScrollArea.Autosize>
                    )
                  )}
                </Stack>
              </Card>
              <Group justify="flex-end" mt="md">
                <Button disabled={!selectedSong} onClick={() => goToStep(1)}>
                  选择难度
                </Button>
              </Group>
            </Stepper.Step>

            <Stepper.Step label="难度" description="谱面类型与等级">
              <Card withBorder radius="md" padding="md" mt="md">
                {!selectedSong ? (
                  <Text size="sm" c="dimmed">
                    请先在第一步选择一首曲目。
                  </Text>
                ) : (
                  <>
                    <Group gap="md" align="flex-start" wrap="nowrap" mb="sm">
                      <SongJacket songId={selectedSong.id} size={80} />
                      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                        <Text fw={600}>
                          {selectedSong.title}{' '}
                          <Text component="span" c="dimmed" size="sm" ff="monospace">
                            #{selectedSong.id}
                          </Text>
                        </Text>
                        <Text size="sm" c="dimmed">
                          {selectedSong.artist}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {songSummaryLine(selectedSong, versionTitlesByCode)}
                        </Text>
                        {selectedSong.map ? (
                          <Text size="xs" c="dimmed">
                            区域：{selectedSong.map}
                          </Text>
                        ) : null}
                        {selectedSong.rights ? (
                          <Text size="xs" c="dimmed" lineClamp={3}>
                            版权：{selectedSong.rights}
                          </Text>
                        ) : null}
                        {(selectedSong.locked || selectedSong.disabled) && (
                          <Group gap="xs">
                            {selectedSong.locked ? (
                              <Badge size="xs" variant="light" color="orange">
                                需解锁
                              </Badge>
                            ) : null}
                            {selectedSong.disabled ? (
                              <Badge size="xs" variant="light" color="red">
                                已禁用
                              </Badge>
                            ) : null}
                          </Group>
                        )}
                      </Stack>
                    </Group>
                    {songPicks.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        该曲目没有可用的难度数据。
                      </Text>
                    ) : (
                      <Group gap="xs">
                        {songPicks.map((p) => {
                          const cd = p.chartDifficulty;
                          const color = DIFFICULTY_COLORS[cd];
                          const active = pick !== null && pickKey(pick) === pickKey(p);
                          const activeFg = contrastingTextForHexBackground(color);
                          return (
                            <Badge
                              key={pickKey(p)}
                              size="lg"
                              variant="outline"
                              style={{
                                cursor: 'pointer',
                                textTransform: 'none',
                                borderColor: color,
                                color: active ? activeFg : color,
                                backgroundColor: active ? color : undefined,
                              }}
                              onClick={() => setPick(p)}
                            >
                              {p.label}
                            </Badge>
                          );
                        })}
                      </Group>
                    )}
                  </>
                )}
              </Card>
              <Group justify="space-between" mt="md">
                <Button variant="default" onClick={() => goToStep(0)}>
                  上一步
                </Button>
                <Button disabled={!pick} onClick={() => goToStep(2)}>
                  预览
                </Button>
              </Group>
            </Stepper.Step>

            <Stepper.Step label="预览" description="谱面与播放">
              {chartError && (
                <Alert color="orange" title="谱面" mt="md">
                  {chartError}
                </Alert>
              )}
              <div className={classes.grid} style={{ marginTop: 'var(--mantine-spacing-md)' }}>
                <Stack gap="md">
                  <div id="normal-chart-container">
                    <div ref={chartCanvasRef}>
                      <ChartCanvas />
                    </div>
                  </div>
                  {!pick && (
                    <Text size="sm" c="dimmed" ta="center">
                      请返回上一步选择难度以加载谱面预览与音频。
                    </Text>
                  )}
                  {pick && chartData && (
                    <Text size="sm" c="dimmed" ta="center">
                      当前：{chartData.title}
                    </Text>
                  )}
                  <PlaybackControls onToggleFullscreen={toggleFullscreen} isFullscreen={false} />
                </Stack>

                <Stack gap="md" className={classes.sidebar}>
                  <Controls />
                  <KeyboardShortcuts />
                </Stack>
              </div>
              <Group justify="flex-start" mt="md">
                <Button variant="default" onClick={() => setWizardStep(1)}>
                  上一步
                </Button>
              </Group>
            </Stepper.Step>
          </Stepper>
        </Stack>
      </Container>

      {isFullscreen && (
        <div className={classes.fullscreen} ref={fullscreenElementRef}>
          <div id="fullscreen-chart-container" style={{ cursor: showControls ? 'default' : 'none' }} />
          <div className={`${classes.fullscreenControls} ${showControls ? classes.showControls : ''}`}>
            <PlaybackControls onToggleFullscreen={toggleFullscreen} isFullscreen />
          </div>
          <ActionIcon
            className={`${classes.lockButton} ${isLocked || showControls ? classes.showButton : ''}`}
            variant="filled"
            color="dark"
            size="lg"
            radius="xl"
            onClick={() => setIsLocked((v) => !v)}
            aria-label={isLocked ? '解锁控制' : '锁定控制'}
          >
            {isLocked ? <IconLock size={20} /> : <IconLockOpen size={20} />}
          </ActionIcon>
        </div>
      )}
    </>
  );
}
