import axios from 'axios';
import { db } from './supabase';

// Docker 容器管理服务
// 这里假设你使用 Railway/Fly.io 等服务托管 Docker
// 需要实现一个简单的 Docker 管理 API

export interface DockerContainer {
  id: string;
  url: string;
  port: number;
  status: 'running' | 'stopped' | 'error';
}

export const dockerService = {
  // 创建并启动 OpenClaw 容器
  async createContainer(
    telegram_user_id: string
  ): Promise<DockerContainer> {
    try {
      // 调用你的 Docker 管理 API
      const response = await axios.post(
        `${process.env.DOCKER_API_URL}/containers/create`,
        {
          image: 'openclaw/openclaw:latest',
          user_id: telegram_user_id,
          env: {
            // OpenClaw 环境变量
            USER_ID: telegram_user_id,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.DOCKER_API_KEY}`,
          },
        }
      );

      const container: DockerContainer = {
        id: response.data.container_id,
        url: response.data.url,
        port: response.data.port,
        status: 'running',
      };

      // 更新数据库
      await db.updateDockerInfo(
        telegram_user_id,
        container.id,
        container.port,
        container.url
      );

      // 记录日志
      await db.logContainerAction(
        telegram_user_id,
        container.id,
        'created',
        `Container created: ${container.url}`
      );

      return container;
    } catch (error: any) {
      await db.logContainerAction(
        telegram_user_id,
        'unknown',
        'error',
        `Failed to create container: ${error.message}`
      );
      throw error;
    }
  },

  // 停止容器
  async stopContainer(container_id: string, telegram_user_id: string): Promise<void> {
    try {
      await axios.post(
        `${process.env.DOCKER_API_URL}/containers/${container_id}/stop`,
        {},
        {
          headers: {
            Authorization: `Bearer ${process.env.DOCKER_API_KEY}`,
          },
        }
      );

      await db.logContainerAction(
        telegram_user_id,
        container_id,
        'stopped',
        'Container stopped'
      );
    } catch (error: any) {
      await db.logContainerAction(
        telegram_user_id,
        container_id,
        'error',
        `Failed to stop container: ${error.message}`
      );
      throw error;
    }
  },

  // 启动容器
  async startContainer(container_id: string, telegram_user_id: string): Promise<void> {
    try {
      await axios.post(
        `${process.env.DOCKER_API_URL}/containers/${container_id}/start`,
        {},
        {
          headers: {
            Authorization: `Bearer ${process.env.DOCKER_API_KEY}`,
          },
        }
      );

      await db.logContainerAction(
        telegram_user_id,
        container_id,
        'started',
        'Container started'
      );
    } catch (error: any) {
      await db.logContainerAction(
        telegram_user_id,
        container_id,
        'error',
        `Failed to start container: ${error.message}`
      );
      throw error;
    }
  },

  // 删除容器
  async removeContainer(container_id: string, telegram_user_id: string): Promise<void> {
    try {
      await axios.delete(
        `${process.env.DOCKER_API_URL}/containers/${container_id}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.DOCKER_API_KEY}`,
          },
        }
      );

      await db.logContainerAction(
        telegram_user_id,
        container_id,
        'removed',
        'Container removed'
      );
    } catch (error: any) {
      await db.logContainerAction(
        telegram_user_id,
        container_id,
        'error',
        `Failed to remove container: ${error.message}`
      );
      throw error;
    }
  },

  // 获取容器状态
  async getContainerStatus(container_id: string): Promise<string> {
    try {
      const response = await axios.get(
        `${process.env.DOCKER_API_URL}/containers/${container_id}/status`,
        {
          headers: {
            Authorization: `Bearer ${process.env.DOCKER_API_KEY}`,
          },
        }
      );

      return response.data.status;
    } catch (error) {
      return 'error';
    }
  },
};
