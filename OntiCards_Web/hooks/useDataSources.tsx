'use client';

import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { getUserDataSources, DataSourceItem } from '@/api/datasource';
import { getUserInfo } from '@/api/user';

// 全局缓存 key
const GLOBAL_CACHE_KEY = 'globalDataSources';

// 缓存过期时间（5分钟）
const CACHE_EXPIRY_MS = 5 * 60 * 1000;

interface CacheMeta {
  data: DataSourceItem[];
  weaviateCount: number;
  timestamp: number;
  userId: string | null;
}

interface DataSourceContextType {
  dataSources: DataSourceItem[];
  weaviateCount: number;
  loading: boolean;
  lastUpdated: number | null;
  // 获取数据源（智能缓存：首次强制刷新，后续使用缓存）
  fetchDataSources: (forceRefresh?: boolean) => Promise<void>;
  // 强制刷新（用于手动刷新或数据变更后）
  refreshDataSources: () => Promise<void>;
  // 清除缓存
  clearCache: () => void;
}

const DataSourceContext = createContext<DataSourceContextType | null>(null);

// 从 localStorage 获取缓存的用户信息
const getCachedUserInfo = (): { id: string } | null => {
  if (typeof window === 'undefined') return null;
  try {
    const cached = window.localStorage.getItem('userInfo');
    if (cached && cached !== 'undefined') {
      return JSON.parse(cached) as { id: string };
    }
  } catch {
    // ignore
  }
  return null;
};

// 事件总线，用于跨页面通知数据源变更
type DataSourceChangeCallback = () => void;
const dataSourceChangeListeners = new Set<DataSourceChangeCallback>();

export const subscribeDataSourceChanges = (callback: DataSourceChangeCallback) => {
  dataSourceChangeListeners.add(callback);
  return () => {
    dataSourceChangeListeners.delete(callback);
  };
};

export const notifyDataSourceChanged = () => {
  dataSourceChangeListeners.forEach(callback => callback());
};

// 事件总线，用于跨页面通知 changelog 变更
const changelogChangeListeners = new Set<DataSourceChangeCallback>();

export const subscribeChangelogChanges = (callback: DataSourceChangeCallback) => {
  changelogChangeListeners.add(callback);
  return () => {
    changelogChangeListeners.delete(callback);
  };
};

export const notifyChangelogChanged = () => {
  changelogChangeListeners.forEach(callback => callback());
};

// 全局缓存元数据
let globalCacheMeta: CacheMeta | null = null;

// 从 sessionStorage 恢复全局缓存
// 注意：必须严格校验 data 是数组，防止损坏缓存把 undefined 流入 state 导致 .reduce 等调用崩溃
const loadGlobalCache = (): CacheMeta | null => {
  if (typeof window === 'undefined') return null;
  try {
    const cached = window.sessionStorage.getItem(GLOBAL_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as Partial<CacheMeta> | null;
      if (!parsed || typeof parsed.timestamp !== 'number') return null;
      // 检查缓存是否过期
      if (Date.now() - parsed.timestamp < CACHE_EXPIRY_MS) {
        return {
          data: Array.isArray(parsed.data) ? parsed.data : [],
          weaviateCount: typeof parsed.weaviateCount === 'number' ? parsed.weaviateCount : 0,
          timestamp: parsed.timestamp,
          userId: typeof parsed.userId === 'string' ? parsed.userId : null,
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
};

// 保存全局缓存
const saveGlobalCache = (data: DataSourceItem[]) => {
  if (typeof window === 'undefined') return;
  try {
    globalCacheMeta = {
      data,
      weaviateCount: globalCacheMeta?.weaviateCount ?? 0,
      timestamp: Date.now(),
      userId: globalCacheMeta?.userId ?? null,
    };
    window.sessionStorage.setItem(GLOBAL_CACHE_KEY, JSON.stringify(globalCacheMeta));
  } catch {
    // ignore
  }
};

// 清除全局缓存
export const clearGlobalDataSourceCache = () => {
  if (typeof window === 'undefined') return;
  globalCacheMeta = null;
  window.sessionStorage.removeItem(GLOBAL_CACHE_KEY);
};

export const DataSourceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [dataSources, setDataSources] = useState<DataSourceItem[]>([]);
  const [weaviateCount, setWeaviateCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const isInitialFetchDone = useRef(false);

  // 智能获取数据源（根据当前登录用户 + 缓存状态决定是否调用接口）
  const fetchDataSources = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      // 确保内存中的缓存元数据已从 sessionStorage 恢复
      if (!globalCacheMeta) {
        const cached = loadGlobalCache();
        if (cached) {
          // loadGlobalCache 已经对 data / weaviateCount 做了兜底，可以安全直接使用
          globalCacheMeta = {
            data: cached.data,
            weaviateCount: cached.weaviateCount,
            timestamp: cached.timestamp,
            userId: cached.userId,
          };
        }
      }

      // 优先从 localStorage 获取用户ID，避免重复调用 API
      const cachedUser = getCachedUserInfo();
      let userId: string | null = cachedUser?.id ?? null;

      // 如果缓存中没有用户信息且需要强制刷新，才调用 API
      if (!userId && forceRefresh) {
        try {
          const userRes = await getUserInfo() as any;
          userId = userRes?.data?.id ?? null;
        } catch {
          // 忽略错误，保持 userId 为 null
        }
      }

      if (!userId) {
        // 未登录或获取用户信息失败，清空状态与缓存
        clearGlobalDataSourceCache();
        setDataSources([]);
        setWeaviateCount(0);
        setLastUpdated(null);
        return;
      }

      const now = Date.now();
      const hasValidCache =
        !forceRefresh &&
        !!globalCacheMeta &&
        globalCacheMeta.userId === userId &&
        now - globalCacheMeta.timestamp < CACHE_EXPIRY_MS;

      if (hasValidCache) {
        // 使用当前用户的有效缓存
        // 再次兜底：防止缓存对象被外部修改导致 data 变成非数组
        const safeItems = Array.isArray(globalCacheMeta.data) ? globalCacheMeta.data : [];
        setDataSources(safeItems);
        setWeaviateCount(
          typeof globalCacheMeta.weaviateCount === 'number'
            ? globalCacheMeta.weaviateCount
            : 0
        );
        setLastUpdated(globalCacheMeta.timestamp);
        return;
      }

      // 缓存无效或用户已变更，调用接口重新获取
      try {
        const res = await getUserDataSources({ user_id: userId, page_size: 100 });
        if (res.code === 200 && res.data?.items) {
          const items = Array.isArray(res.data.items) ? res.data.items : [];
          const nextWeaviateCount = res.data.weaviate_count || 0;
          setDataSources(items);
          setWeaviateCount(nextWeaviateCount);
          setLastUpdated(now);
          globalCacheMeta = {
            data: items,
            weaviateCount: nextWeaviateCount,
            timestamp: now,
            userId,
          };
          if (typeof window !== 'undefined') {
            window.sessionStorage.setItem(GLOBAL_CACHE_KEY, JSON.stringify(globalCacheMeta));
          }
        } else {
          // 接口异常时，清空数据以避免展示错误用户的数据
          setDataSources([]);
          setWeaviateCount(0);
          setLastUpdated(now);
          clearGlobalDataSourceCache();
        }
      } catch (e) {
        console.error('获取数据源失败', e);
        // 兜底：网络/解析异常时也清空数据，避免留下污染的 state
        setDataSources([]);
        setWeaviateCount(0);
        setLastUpdated(now);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // 强制刷新（用于手动刷新或数据变更后）
  const refreshDataSources = useCallback(async () => {
    await fetchDataSources(true);
  }, []);

  // 清除缓存
  const clearCache = useCallback(() => {
    clearGlobalDataSourceCache();
    setDataSources([]);
    setWeaviateCount(0);
    setLastUpdated(null);
  }, []);

  // 初始化：恢复缓存并尝试使用缓存
  useEffect(() => {
    // 尝试从 sessionStorage 恢复缓存
    const cached = loadGlobalCache();
    if (cached) {
      // loadGlobalCache 已经对 data / weaviateCount 做了类型校验与兜底
      setDataSources(cached.data);
      setWeaviateCount(cached.weaviateCount);
      setLastUpdated(cached.timestamp);
    }

    // 标记首次获取完成（但不立即触发 API 调用）
    isInitialFetchDone.current = true;
  }, []);

  // 监听跨页面数据变更事件
  useEffect(() => {
    const unsubscribe = subscribeDataSourceChanges(() => {
      // 收到变更通知后，强制刷新数据
      refreshDataSources();
    });
    return unsubscribe;
  }, [refreshDataSources]);

  return (
    <DataSourceContext.Provider
      value={{
        dataSources,
        weaviateCount,
        loading,
        lastUpdated,
        fetchDataSources,
        refreshDataSources,
        clearCache,
      }}
    >
      {children}
    </DataSourceContext.Provider>
  );
};

// 自定义 Hook：使用数据源上下文
export const useDataSources = () => {
  const context = useContext(DataSourceContext);
  if (!context) {
    throw new Error('useDataSources must be used within DataSourceProvider');
  }
  return context;
};

export default DataSourceContext;
