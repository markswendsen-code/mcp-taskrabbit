#!/usr/bin/env node

/**
 * Strider Labs TaskRabbit MCP Server
 *
 * MCP server that gives AI agents the ability to search home services,
 * browse taskers, book tasks, view bookings, message taskers, and cancel tasks.
 * https://striderlabs.ai
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  checkAuth,
  searchTaskCategories,
  getTaskers,
  getTaskerProfile,
  bookTask,
  getTasks,
  messageTasker,
  cancelTask,
  getLoginUrl,
  cleanup,
} from "./browser.js";
import { hasStoredCookies, clearCookies, getCookiesPath } from "./auth.js";

const server = new Server(
  {
    name: "strider-taskrabbit",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "taskrabbit_auth_check",
        description:
          "Check if user is logged in to TaskRabbit. Returns login status and instructions if not authenticated. Call this before any other TaskRabbit operations.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "taskrabbit_auth_clear",
        description:
          "Clear stored TaskRabbit session cookies. Use this to log out or reset authentication state.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "taskrabbit_search_tasks",
        description:
          "Search available task categories and service types on TaskRabbit (e.g., 'furniture assembly', 'cleaning', 'handyman', 'moving'). Returns a list of matching service categories.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Optional search query to filter categories (e.g., 'cleaning', 'plumbing', 'moving'). Leave empty to get all categories.",
            },
          },
        },
      },
      {
        name: "taskrabbit_get_taskers",
        description:
          "Get available taskers for a specific task type and location. Returns tasker profiles with ratings, hourly rates, and review counts.",
        inputSchema: {
          type: "object",
          properties: {
            taskType: {
              type: "string",
              description:
                "The type of task or service (e.g., 'furniture assembly', 'house cleaning', 'handyman')",
            },
            location: {
              type: "string",
              description:
                "City, zip code, or address (e.g., 'San Francisco, CA', '94102', 'New York, NY')",
            },
            sortBy: {
              type: "string",
              enum: ["price", "rating", "reviews"],
              description: "Sort results by price, rating, or number of reviews",
            },
          },
          required: ["taskType", "location"],
        },
      },
      {
        name: "taskrabbit_get_tasker",
        description:
          "Get detailed profile for a specific tasker, including reviews, skills, response time, and availability. Use the tasker ID from taskrabbit_get_taskers results.",
        inputSchema: {
          type: "object",
          properties: {
            taskerId: {
              type: "string",
              description: "The tasker's ID or username slug (from taskrabbit_get_taskers results)",
            },
          },
          required: ["taskerId"],
        },
      },
      {
        name: "taskrabbit_book_task",
        description:
          "Book a task with a specific tasker. Set confirm=false to preview booking details, confirm=true to actually submit the booking. Must be logged in.",
        inputSchema: {
          type: "object",
          properties: {
            taskerId: {
              type: "string",
              description: "The tasker's ID or username slug",
            },
            taskType: {
              type: "string",
              description: "The type of task being booked (e.g., 'furniture assembly')",
            },
            date: {
              type: "string",
              description:
                "Requested date in YYYY-MM-DD format (e.g., '2025-03-15')",
            },
            time: {
              type: "string",
              description:
                "Requested start time (e.g., '10:00 AM', '2:30 PM', '14:00')",
            },
            location: {
              type: "string",
              description:
                "Full address where the task will be performed (e.g., '123 Main St, San Francisco, CA 94102')",
            },
            description: {
              type: "string",
              description:
                "Optional description of the task and any special requirements",
            },
            confirm: {
              type: "boolean",
              description:
                "Set to true to actually submit the booking, false to just preview. Default is false.",
            },
          },
          required: ["taskerId", "taskType", "date", "time", "location"],
        },
      },
      {
        name: "taskrabbit_get_tasks",
        description:
          "View your booked and active tasks on TaskRabbit. Returns task details including status, tasker, date, and price.",
        inputSchema: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              enum: ["active", "completed", "all"],
              description:
                "Filter tasks by status. Defaults to 'all' if not specified.",
            },
          },
        },
      },
      {
        name: "taskrabbit_message_tasker",
        description:
          "Send a message to a tasker through the TaskRabbit inbox. Use the tasker's ID or a task ID to identify the conversation.",
        inputSchema: {
          type: "object",
          properties: {
            taskerId: {
              type: "string",
              description: "The tasker's ID or username to message",
            },
            message: {
              type: "string",
              description: "The message to send to the tasker",
            },
            taskId: {
              type: "string",
              description:
                "Optional task ID to send the message within a specific task conversation",
            },
          },
          required: ["taskerId", "message"],
        },
      },
      {
        name: "taskrabbit_cancel_task",
        description:
          "Cancel a booked task. Use the task ID from taskrabbit_get_tasks results. Cancellation policies may apply.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The task ID to cancel (from taskrabbit_get_tasks results)",
            },
            reason: {
              type: "string",
              description: "Optional reason for cancellation",
            },
          },
          required: ["taskId"],
        },
      },
    ],
  };
});

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "taskrabbit_auth_check": {
        const hasCookies = hasStoredCookies();

        if (!hasCookies) {
          const loginInfo = await getLoginUrl();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  isLoggedIn: false,
                  message: "Not logged in to TaskRabbit.",
                  loginUrl: loginInfo.url,
                  instructions: loginInfo.instructions,
                  cookiesPath: getCookiesPath(),
                }),
              },
            ],
          };
        }

        const authState = await checkAuth();

        if (!authState.isLoggedIn) {
          const loginInfo = await getLoginUrl();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  isLoggedIn: false,
                  message: "Session expired. Please log in again.",
                  loginUrl: loginInfo.url,
                  instructions: loginInfo.instructions,
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                isLoggedIn: true,
                message: "Logged in to TaskRabbit.",
              }),
            },
          ],
        };
      }

      case "taskrabbit_auth_clear": {
        clearCookies();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "TaskRabbit session cleared. You will need to log in again.",
              }),
            },
          ],
        };
      }

      case "taskrabbit_search_tasks": {
        const { query } = (args || {}) as { query?: string };
        const result = await searchTaskCategories(query);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "taskrabbit_get_taskers": {
        const { taskType, location, sortBy } = args as {
          taskType: string;
          location: string;
          sortBy?: "price" | "rating" | "reviews";
        };
        const result = await getTaskers(taskType, location, { sortBy });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "taskrabbit_get_tasker": {
        const { taskerId } = args as { taskerId: string };
        const result = await getTaskerProfile(taskerId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "taskrabbit_book_task": {
        const { taskerId, taskType, date, time, location, description, confirm } =
          args as {
            taskerId: string;
            taskType: string;
            date: string;
            time: string;
            location: string;
            description?: string;
            confirm?: boolean;
          };

        const result = await bookTask(taskerId, taskType, {
          date,
          time,
          location,
          description,
          confirm: confirm ?? false,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "taskrabbit_get_tasks": {
        const { filter } = (args || {}) as {
          filter?: "active" | "completed" | "all";
        };
        const result = await getTasks(filter);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "taskrabbit_message_tasker": {
        const { taskerId, message, taskId } = args as {
          taskerId: string;
          message: string;
          taskId?: string;
        };
        const result = await messageTasker(taskerId, message, taskId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      case "taskrabbit_cancel_task": {
        const { taskId, reason } = args as {
          taskId: string;
          reason?: string;
        };
        const result = await cancelTask(taskId, reason);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: !result.success,
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Unknown tool: ${name}`,
              }),
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }),
        },
      ],
      isError: true,
    };
  }
});

// Cleanup on exit
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(0);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Strider TaskRabbit MCP server running");
}

main().catch(console.error);
