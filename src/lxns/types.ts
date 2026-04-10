export interface LxnsAliasEntry {
  song_id: number;
  aliases: string[];
}

export interface LxnsAliasListResponse {
  aliases: LxnsAliasEntry[];
}

export interface LxnsDifficultyRow {
  type: 'standard' | 'dx' | 'utage';
  difficulty: number;
  level: string;
  level_value: number;
  note_designer?: string;
  version?: number;
  kanji?: string;
  description?: string;
}

export interface LxnsSongDifficulties {
  standard: LxnsDifficultyRow[];
  dx: LxnsDifficultyRow[];
  utage?: LxnsDifficultyRow[];
}

export interface LxnsSong {
  id: number;
  title: string;
  artist: string;
  genre: string;
  bpm: number;
  version: number;
  difficulties: LxnsSongDifficulties;
  /** 曲目所属区域，可空 */
  map?: string | null;
  /** 版权信息，可空 */
  rights?: string | null;
  /** 是否需要解锁 */
  locked?: boolean;
  /** 是否禁用（不出现在 Best 50 等） */
  disabled?: boolean;
}

export interface LxnsGenreEntry {
  id: number;
  title: string;
  genre: string;
}

export interface LxnsVersionEntry {
  id: number;
  title: string;
  version: number;
}

export interface LxnsSongListResponse {
  songs: LxnsSong[];
  genres?: LxnsGenreEntry[];
  versions?: LxnsVersionEntry[];
}
