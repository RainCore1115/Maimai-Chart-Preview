import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Group, Image, Loader, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { maiChartsDataUrl, songArtUrl, songPackUrl } from '../maicharts/data';

export interface LibraryPack {
  num: number;
  version: string;
  file: string;
}

interface SongChart {
  k: 'standard' | 'dx' | 'utage';
  d: number;
  lv: number;
  plus: boolean;
}

interface SongEntry {
  t: string;
  a: string;
  g: string;
  v: string;
  p: string;
  sid: number | null;
  c: SongChart[];
}

interface SongsFile {
  songs: SongEntry[];
}

const DIFFS: { d: number; label: string; icon: string; color: string }[] = [
  { d: 2, label: 'BASIC', icon: 'd_0', color: 'green' },
  { d: 3, label: 'ADVANCED', icon: 'd_1', color: 'yellow' },
  { d: 4, label: 'EXPERT', icon: 'd_2', color: 'red' },
  { d: 5, label: 'MASTER', icon: 'd_3', color: 'violet' },
  { d: 6, label: 'RE:MASTER', icon: 'd_4', color: 'pink' },
  { d: 1, label: 'UTAGE', icon: '', color: 'orange' },
];
const DIFF_BY_D = new Map(DIFFS.map((d) => [d.d, d]));

const GENRES: { g: string; label: string; icon: string }[] = [
  { g: 'POPS＆アニメ', label: 'POPS＆动画', icon: 'info_anime' },
  { g: 'niconico＆ボーカロイド', label: 'niconico＆VOCALOID', icon: 'info_niconico' },
  { g: '東方Project', label: '東方Project', icon: 'info_touhou' },
  { g: 'ゲーム＆バラエティ', label: '游戏＆综艺', icon: 'info_game' },
  { g: 'maimai', label: 'maimai', icon: 'info_maimai' },
  { g: 'オンゲキ＆CHUNITHM', label: 'オンゲキ＆CHUNITHM', icon: 'info_ongeki' },
  { g: '宴会場', label: '宴会場', icon: 'chart_info_enkaijou' },
];

type SortKey = 'lv_desc' | 'lv_asc' | 'v_desc' | 'v_asc' | 't_asc' | 't_desc';

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'lv_desc', label: '定数 高→低' },
  { value: 'lv_asc', label: '定数 低→高' },
  { value: 'v_desc', label: '版本 新→旧' },
  { value: 'v_asc', label: '版本 旧→新' },
  { value: 't_asc', label: '曲名 A→Z' },
  { value: 't_desc', label: '曲名 Z→A' },
];

const versionNum = (v: string) => parseInt(v.slice(0, 2), 10) || 0;
const levelText = (c: SongChart) => `${c.lv}${c.plus ? '+' : ''}`;
const songMaxLv = (s: SongEntry) => s.c.reduce((m, c) => Math.max(m, c.lv), 0);

function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

interface Props {
  packs: LibraryPack[];
}

export default function SongLibrarySection({ packs }: Props) {
  const [songs, setSongs] = useState<SongEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [genres, setGenres] = useState<Set<string>>(new Set());
  const [versions, setVersions] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Set<number>>(new Set());
  const [lvMin, setLvMin] = useState<string>('不限');
  const [lvMax, setLvMax] = useState<string>('不限');
  const [sort, setSort] = useState<SortKey>('lv_desc');
  const [limit, setLimit] = useState(60);

  useEffect(() => {
    let cancelled = false;
    fetch(maiChartsDataUrl('songs.json'), { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<SongsFile>;
      })
      .then((json) => {
        if (!cancelled) setSongs(json.songs ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const versionOptions = useMemo(
    () => [...packs].sort((a, b) => b.num - a.num),
    [packs]
  );

  const minLv = lvMin === '不限' ? 0 : Number(lvMin);
  const maxLv = lvMax === '不限' ? 99 : Number(lvMax);

  const matched = useMemo(() => {
    if (!songs) return [];
    const q = query.trim().toLowerCase();
    const out = songs.filter((s) => {
      if (q && !`${s.t} ${s.a}`.toLowerCase().includes(q)) return false;
      if (genres.size > 0 && !genres.has(s.g)) return false;
      if (versions.size > 0 && !versions.has(s.v)) return false;
      if (diffs.size > 0 && !s.c.some((c) => diffs.has(c.d))) return false;
      if (minLv > 0 || maxLv < 99) {
        if (!s.c.some((c) => c.lv >= minLv && c.lv <= maxLv)) return false;
      }
      return true;
    });
    out.sort((a, b) => {
      switch (sort) {
        case 'lv_desc':
          return songMaxLv(b) - songMaxLv(a) || a.t.localeCompare(b.t, 'ja');
        case 'lv_asc':
          return songMaxLv(a) - songMaxLv(b) || a.t.localeCompare(b.t, 'ja');
        case 'v_desc':
          return versionNum(b.v) - versionNum(a.v) || a.t.localeCompare(b.t, 'ja');
        case 'v_asc':
          return versionNum(a.v) - versionNum(b.v) || a.t.localeCompare(b.t, 'ja');
        case 't_asc':
          return a.t.localeCompare(b.t, 'ja');
        default:
          return b.t.localeCompare(a.t, 'ja');
      }
    });
    return out;
  }, [songs, query, genres, versions, diffs, minLv, maxLv, sort]);

  const reset = () => {
    setQuery('');
    setGenres(new Set());
    setVersions(new Set());
    setDiffs(new Set());
    setLvMin('不限');
    setLvMax('不限');
    setSort('lv_desc');
    setLimit(60);
  };

  const activeFilter =
    query.trim() !== '' || genres.size > 0 || versions.size > 0 || diffs.size > 0 || lvMin !== '不限' || lvMax !== '不限';

  if (failed) {
    return (
      <Stack gap="xs">
        <Title order={3}>单曲歌曲包下载</Title>
        <Text size="sm" c="red">
          曲库索引加载失败，请刷新重试。
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Title order={3}>单曲歌曲包下载</Title>
          <Text size="sm" c="dimmed">
            按 流派 / 版本 / 难度 / 定数 分类浏览，下载该曲的完整包（maidata + 音频 + 曲绘 + pv），取自 mai-charts 曲目目录。
          </Text>
        </div>
        <Group gap="xs">
          <Badge size="lg" variant="light" color="cyan">
            {songs ? songs.length : '…'} 首可下载
          </Badge>
          {activeFilter && (
            <Button size="compact-sm" variant="subtle" color="gray" onClick={reset}>
              重置筛选
            </Button>
          )}
        </Group>
      </Group>

      <Group gap="xs" wrap="wrap">
        <TextInput
          placeholder="搜索曲名 / 曲师…"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setLimit(60);
          }}
          style={{ flex: '1 1 240px' }}
        />
        <Select
          value={lvMin}
          onChange={(v) => {
            setLvMin(v ?? '不限');
            setLimit(60);
          }}
          data={['不限', ...Array.from({ length: 15 }, (_, i) => String(i + 1))]}
          label={undefined}
          style={{ flex: '0 0 110px' }}
          aria-label="定数下限"
        />
        <Text size="sm" c="dimmed">
          ～
        </Text>
        <Select
          value={lvMax}
          onChange={(v) => {
            setLvMax(v ?? '不限');
            setLimit(60);
          }}
          data={['不限', ...Array.from({ length: 15 }, (_, i) => String(i + 1))]}
          style={{ flex: '0 0 110px' }}
          aria-label="定数上限"
        />
        <Select
          value={sort}
          onChange={(v) => setSort((v as SortKey) ?? 'lv_desc')}
          data={SORTS}
          style={{ flex: '0 0 150px' }}
          aria-label="排序"
        />
      </Group>

      <Group gap={6} wrap="wrap">
        <Text size="xs" c="dimmed" w={44}>
          难度
        </Text>
        {DIFFS.map((d) => (
          <Button
            key={d.d}
            size="compact-xs"
            variant={diffs.has(d.d) ? 'filled' : 'light'}
            color={d.color}
            onClick={() => {
              setDiffs((prev) => {
                const next = new Set(prev);
                if (next.has(d.d)) next.delete(d.d);
                else next.add(d.d);
                return next;
              });
              setLimit(60);
            }}
          >
            {d.icon ? <img src={songArtUrl(`${d.icon}.webp`)} alt="" height={14} style={{ marginRight: 4 }} /> : null}
            {d.label}
          </Button>
        ))}
      </Group>

      <Group gap={6} wrap="wrap">
        <Text size="xs" c="dimmed" w={44}>
          流派
        </Text>
        {GENRES.map((g) => (
          <Button
            key={g.g}
            size="compact-xs"
            variant={genres.has(g.g) ? 'filled' : 'light'}
            color="gray"
            onClick={() => {
              setGenres((prev) => toggle(prev, g.g));
              setLimit(60);
            }}
          >
            <img src={songArtUrl(`${g.icon}.webp`)} alt="" height={14} style={{ marginRight: 4 }} />
            {g.label}
          </Button>
        ))}
      </Group>

      <Group gap={6} wrap="wrap">
        <Text size="xs" c="dimmed" w={44}>
          版本
        </Text>
        <Button
          size="compact-xs"
          variant={versions.size === 0 ? 'filled' : 'light'}
          color="cyan"
          onClick={() => {
            setVersions(new Set());
            setLimit(60);
          }}
        >
          全部
        </Button>
        {versionOptions.map((p) => (
          <Button
            key={p.num}
            size="compact-xs"
            variant={versions.has(p.version) ? 'filled' : 'subtle'}
            color={versions.has(p.version) ? 'cyan' : 'gray'}
            onClick={() => {
              setVersions((prev) => toggle(prev, p.version));
              setLimit(60);
            }}
          >
            {p.version}
          </Button>
        ))}
      </Group>

      {!songs ? (
        <Group justify="center" py="md">
          <Loader size="sm" />
        </Group>
      ) : matched.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          没有匹配的曲目，试试放宽筛选。
        </Text>
      ) : (
        <>
          <Text size="xs" c="dimmed">
            命中 {matched.length} 首，显示前 {Math.min(limit, matched.length)} 首
            {matched.length === songs.length ? '' : '（已按筛选条件过滤）'}
          </Text>
          <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 5 }} spacing="sm">
            {matched.slice(0, limit).map((song) => (
              <Card key={song.p} withBorder padding="xs" radius="md">
                <Card.Section>
                  <div style={{ position: 'relative' }}>
                    <Image
                      src={song.sid ? `${import.meta.env.BASE_URL}api/cover/${song.sid}` : undefined}
                      alt=""
                      h={110}
                      fit="cover"
                      fallbackSrc={songArtUrl('info_maimai.webp')}
                      loading="lazy"
                    />
                    <Group gap={4} style={{ position: 'absolute', left: 4, top: 4 }}>
                      {versionNum(song.v) === 0 ? (
                        <Badge size="xs" color="orange" variant="filled">
                          宴
                        </Badge>
                      ) : null}
                      {song.c.some((c) => c.k === 'dx') ? (
                        <img src={songArtUrl('DX.webp')} alt="DX" height={16} />
                      ) : (
                        <Badge size="xs" color="gray" variant="filled">
                          ST
                        </Badge>
                      )}
                    </Group>
                  </div>
                </Card.Section>
                <Stack gap={4} mt={6}>
                  <Text size="xs" fw={600} lineClamp={2} title={song.t}>
                    {song.t}
                  </Text>
                  <Text size="10px" c="dimmed" lineClamp={1} title={song.a}>
                    {song.a}
                  </Text>
                  <Group gap={3} wrap="wrap">
                    {song.c
                      .slice()
                      .sort((a, b) => a.d - b.d)
                      .map((c) => {
                        const meta = DIFF_BY_D.get(c.d);
                        if (!meta) return null;
                        return (
                          <Badge
                            key={`${c.k}-${c.d}`}
                            size="xs"
                            variant="light"
                            color={meta.color}
                            leftSection={
                              meta.icon ? (
                                <img src={songArtUrl(`${meta.icon}.webp`)} alt="" height={10} />
                              ) : undefined
                            }
                          >
                            {levelText(c)}
                          </Badge>
                        );
                      })}
                  </Group>
                  <Button size="compact-xs" variant="light" color="teal" component="a" href={songPackUrl(song.p)}>
                    下载歌曲包
                  </Button>
                </Stack>
              </Card>
            ))}
          </SimpleGrid>
          {matched.length > limit && (
            <Group justify="center">
              <Button variant="default" onClick={() => setLimit((v) => v + 120)}>
                加载更多（剩 {matched.length - limit} 首）
              </Button>
            </Group>
          )}
        </>
      )}
    </Stack>
  );
}
