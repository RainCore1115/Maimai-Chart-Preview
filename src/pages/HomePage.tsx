import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Stack, Text } from '@mantine/core';
import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import Prism from '../components/react-bits/Prism/Prism';
import RotatingText from '../components/react-bits/RotatingText/RotatingText';
import classes from './HomePage.module.css';

const ROTATING_SUFFIXES = ['预览', '查询', '自动播放'];

const widthSpring = {
  type: 'spring' as const,
  stiffness: 88,
  damping: 13,
  mass: 0.92,
};

/** 用 ResizeObserver + 显式 animate.width，比 layout 更容易看出弹簧；居中裁切避免单侧硬切 */
function AnimatedPillWidth({
  children,
  className,
  rotationCount,
}: {
  children: React.ReactNode;
  className?: string;
  /** 来自 RotatingText onNext：0=仍为首帧文案，≥1 之后宽度变化走弹簧 */
  rotationCount: number;
}) {
  const innerRef = useRef<HTMLSpanElement>(null);
  const [w, setW] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    const read = () => {
      const nw = Math.ceil(el.getBoundingClientRect().width);
      setW(nw);
    };

    read();
    const ro = new ResizeObserver(read);
    ro.observe(el, { box: 'border-box' });
    return () => ro.disconnect();
  }, []);

  return (
    <motion.span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        justifyContent: 'center',
        overflow: 'hidden',
        verticalAlign: 'baseline',
      }}
      initial={false}
      animate={w === undefined ? {} : { width: w }}
      transition={rotationCount === 0 ? { duration: 0 } : widthSpring}
    >
      <span ref={innerRef} style={{ display: 'inline-flex', width: 'max-content', flexShrink: 0 }}>
        {children}
      </span>
    </motion.span>
  );
}

export default function HomePage() {
  const [rotationCount, setRotationCount] = useState(0);

  return (
    <div className={classes.root}>
      <div className={classes.prismWrap} aria-hidden>
        <Prism animationType="3drotate" timeScale={0.42} hueShift={0.15} glow={1.1} bloom={1.05} noise={0.35} />
      </div>
      <div className={classes.scrim} />
      <Stack className={classes.content} gap="lg" justify="center" align="center">
        <Text size="sm" tt="uppercase" fw={600} c="dimmed" style={{ letterSpacing: '0.2em' }}>
          maimai DX
        </Text>

        <div className={classes.titleRow}>
          <div className={classes.titleRowInner}>
            <span className={classes.titlePrefix}>舞萌谱面</span>
            <AnimatedPillWidth className={classes.rotatingOuter} rotationCount={rotationCount}>
              <RotatingText
                texts={ROTATING_SUFFIXES}
                rotationInterval={2800}
                splitBy="characters"
                staggerFrom="last"
                staggerDuration={0.025}
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '-120%' }}
                layoutAnimation={false}
                onNext={() => setRotationCount((n) => n + 1)}
                mainClassName={classes.rotatingTextMain}
                splitLevelClassName={classes.rotatingSplitLevel}
                transition={{ type: 'spring', damping: 30, stiffness: 400 }}
              />
            </AnimatedPillWidth>
          </div>
        </div>

        <Text className={classes.subtitle} size="sm" c="dimmed">
          数据来自 maimai.lxns.net · 本地谱面渲染与播放
        </Text>

        <div className={classes.actions}>
          <Button component={Link} to="/preview" size="md" radius="md" variant="gradient" gradient={{ from: 'cyan', to: 'indigo', deg: 120 }}>
            进入谱面预览
          </Button>
        </div>
      </Stack>
    </div>
  );
}
