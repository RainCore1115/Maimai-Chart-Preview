import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { maiChartsDataUrl } from '../maicharts/data';
import SongLibrarySection from './SongLibrarySection';
import classes from './DownloadPage.module.css';

interface PackInfo {
  num: number;
  name: string;
  version: string;
  size: number;
  sizeLabel: string;
  fid: string;
  file: string;
}

const FULL_MIRROR = 'https://cnb.cool/project-baka86/mai-charts';
const fullDirName = (file: string) => file.replace(/\.zip$/i, '');
const fullDirTree = (file: string) => `${FULL_MIRROR}/-/tree/main/packs/${encodeURIComponent(fullDirName(file))}`;
const fullDirZip = (file: string) => `${FULL_MIRROR}/-/git/archive/main/packs/${encodeURIComponent(fullDirName(file))}.zip`;

interface PacksFile {
  generatedAt: string;
  shareUrl: string;
  sharePwd: string;
  totalSize: number;
  totalSizeLabel: string;
  packs: PackInfo[];
}

function formatDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export default function DownloadPage() {
  const [data, setData] = useState<PacksFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proxyOk, setProxyOk] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(maiChartsDataUrl('download-packs.json'), { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<PacksFile>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message ?? err));
      });
    // 检测本站是否配置了下载代理（Cloudflare Pages Function）
    fetch(`${import.meta.env.BASE_URL}api/dl?status=1`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled) setProxyOk(Boolean(json?.ok));
      })
      .catch(() => {
        if (!cancelled) setProxyOk(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const packs = useMemo(() => [...(data?.packs ?? [])].sort((a, b) => a.num - b.num), [data]);
  const latest = packs[packs.length - 1];

  return (
    <div className={classes.root}>
      <div className={classes.inner}>
        <Stack gap="md">
          <Group justify="space-between" align="flex-end" wrap="wrap">
            <div>
              <Title order={1}>谱面下载站</Title>
              <Text c="dimmed" size="sm" mt={4}>
                按版本打包的 maimai DX 全量谱面（.zip，内含 maidata.txt / 音频 / 曲绘 / pv），数据源为夸克网盘分享，完整包直接取自 mai-charts 仓库的版本目录（CNB 直链）。
              </Text>
            </div>
            <Group gap="xs">
              <Button component={Link} to="/preview" variant="light" radius="md">
                谱面预览
              </Button>
              <Button component={Link} to="/" variant="subtle" radius="md">
                返回首页
              </Button>
            </Group>
          </Group>

          {error && (
            <Alert color="red" title="版本包清单加载失败" variant="light">
              {error}
            </Alert>
          )}

          {!error && !data && (
            <Group gap="sm">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                正在加载版本包清单…
              </Text>
            </Group>
          )}

          {data && (
            <Group gap="md" wrap="wrap">
              <Badge size="lg" variant="light" color="cyan">
                {packs.length} 个版本包
              </Badge>
              <Badge size="lg" variant="light" color="indigo">
                共 {data.totalSizeLabel}
              </Badge>
              {latest && (
                <Badge size="lg" variant="light" color="grape">
                  最新：{latest.version}
                </Badge>
              )}
              <Badge size="lg" variant="outline" color={proxyOk ? 'teal' : 'gray'}>
                {proxyOk === null ? '代理检测中…' : proxyOk ? '本站代理可用' : '本站代理未配置'}
              </Badge>
            </Group>
          )}

          <SongLibrarySection packs={packs} />

          {data && (
            <Alert variant="light" color="blue" title="下载说明">
              <Text size="sm">
                1. 「完整包下载」为 CNB 直链的版本目录归档，内容与网盘原包一致（maidata + 音频 + 曲绘 + pv），单包几百 MB ~ 1 GB，暂不支持断点续传；
                <br />
                2. 「原包中转」走本站中转（支持 Range 断点续传），「镜像直链」跳转 CNB Release 备用镜像版本包。
                <br />
                3. 若「本站下载」不可用，可打开
                <a href={data.shareUrl} target="_blank" rel="noreferrer">
                  夸克网盘分享
                </a>
                （提取码 <b>{data.sharePwd}</b>）自行转存下载；
                <br />
                3. 「完整目录」为解压后的每首歌目录（maidata.txt / track.mp3 / bg.png / pv.mp4），可浏览或按目录打包下载（含音频曲绘），位于 mai-charts 仓库；
                <br />
                4. 谱面包仅供个人学习与谱面预览使用。
              </Text>
            </Alert>
          )}

          {data && (
            <div className={classes.tableWrap}>
              <Table highlightOnHover striped withTableBorder verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>版本</Table.Th>
                    <Table.Th>文件</Table.Th>
                    <Table.Th className={classes.sizeCell}>大小</Table.Th>
                    <Table.Th className={classes.actionCell}>浏览</Table.Th>
                    <Table.Th className={classes.actionCell}>下载</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {packs.map((pack) => (
                    <Table.Tr key={pack.fid}>
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {pack.version}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {pack.file}
                        </Text>
                      </Table.Td>
                      <Table.Td className={classes.sizeCell}>
                        <Text size="sm">{pack.sizeLabel}</Text>
                      </Table.Td>
                      <Table.Td className={classes.actionCell}>
                        <Group gap="xs" justify="flex-end" wrap="nowrap">
                          <Button size="xs" variant="subtle" color="gray" component="a" href={fullDirTree(pack.file)} target="_blank" rel="noreferrer">
                            浏览
                          </Button>
                          <Button size="xs" variant="subtle" color="gray" component="a" href={`${import.meta.env.BASE_URL}api/pack/${pack.num}?direct=1`}>
                            镜像直链
                          </Button>
                        </Group>
                      </Table.Td>
                      <Table.Td className={classes.actionCell}>
                        <Group gap="xs" justify="flex-end" wrap="nowrap">
                          <Button
                            size="xs"
                            radius="md"
                            variant="gradient"
                            gradient={{ from: 'cyan', to: 'indigo', deg: 120 }}
                            component="a"
                            href={fullDirZip(pack.file)}
                          >
                            完整包下载
                          </Button>
                          <Button
                            size="xs"
                            variant="light"
                            color="cyan"
                            component="a"
                            href={`${import.meta.env.BASE_URL}api/pack/${pack.num}?direct=1`}
                          >
                            直链
                          </Button>
                          <Button
                            size="xs"
                            radius="md"
                            variant="default"
                            component="a"
                            href={`${import.meta.env.BASE_URL}api/dl?f=${encodeURIComponent(pack.fid)}`}
                          >
                            原包中转
                          </Button>
                          <Button
                            size="xs"
                            radius="md"
                            variant="subtle"
                            component="a"
                            href={data.shareUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            网盘
                          </Button>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}

          {data && (
            <Text size="xs" c="dimmed">
              清单更新时间：{formatDate(data.generatedAt)}
              {proxyOk === false ? ' · 本站代理未配置时请在网盘下载' : ''}
            </Text>
          )}
        </Stack>
      </div>
    </div>
  );
}
