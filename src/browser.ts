/**
 * TaskRabbit Browser Automation
 *
 * Playwright-based automation for TaskRabbit operations.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { saveCookies, loadCookies, getAuthState, AuthState } from "./auth.js";

const TASKRABBIT_BASE_URL = "https://www.taskrabbit.com";
const DEFAULT_TIMEOUT = 30000;

// Singleton browser instance
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

export interface TaskCategory {
  id: string;
  name: string;
  slug: string;
  description?: string;
  imageUrl?: string;
}

export interface Tasker {
  id: string;
  name: string;
  slug?: string;
  rating: number;
  reviewCount: number;
  hourlyRate: number;
  tasksCompleted?: number;
  skills?: string[];
  bio?: string;
  imageUrl?: string;
  responseTime?: string;
  eliteStatus?: boolean;
}

export interface TaskerProfile extends Tasker {
  reviews?: TaskerReview[];
  availability?: string[];
  badges?: string[];
  verifications?: string[];
}

export interface TaskerReview {
  author: string;
  rating: number;
  comment: string;
  date?: string;
  taskType?: string;
}

export interface BookedTask {
  id: string;
  status: string;
  taskType: string;
  taskerName: string;
  taskerId?: string;
  scheduledDate?: string;
  scheduledTime?: string;
  location?: string;
  price?: number;
  notes?: string;
}

/**
 * Initialize browser with stealth settings
 */
async function initBrowser(): Promise<void> {
  if (browser) return;

  browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });

  await loadCookies(context);

  page = await context.newPage();

  // Block unnecessary resources for speed
  await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2}", (route) =>
    route.abort()
  );
}

async function getPage(): Promise<Page> {
  await initBrowser();
  if (!page) throw new Error("Page not initialized");
  return page;
}

async function getContext(): Promise<BrowserContext> {
  await initBrowser();
  if (!context) throw new Error("Context not initialized");
  return context;
}

/**
 * Check if user is logged in
 */
export async function checkAuth(): Promise<AuthState> {
  const ctx = await getContext();
  const p = await getPage();

  await p.goto(TASKRABBIT_BASE_URL, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT,
  });
  await p.waitForTimeout(2000);

  const authState = await getAuthState(ctx);
  await saveCookies(ctx);

  return authState;
}

/**
 * Search available task categories / service types
 */
export async function searchTaskCategories(
  query?: string
): Promise<{ success: boolean; categories?: TaskCategory[]; error?: string }> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    const url = query
      ? `${TASKRABBIT_BASE_URL}/services?q=${encodeURIComponent(query)}`
      : `${TASKRABBIT_BASE_URL}/services`;

    await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(3000);

    const categories: TaskCategory[] = [];

    // Try category cards
    const categoryCards = p.locator(
      '[data-testid="category-card"], [class*="CategoryCard"], [class*="category-card"], ' +
      'a[href*="/services/"], a[href*="/m/categories/"]'
    );
    await categoryCards.first().waitFor({ timeout: 8000 }).catch(() => {});

    const cardCount = await categoryCards.count();

    for (let i = 0; i < Math.min(cardCount, 50); i++) {
      const card = categoryCards.nth(i);

      try {
        const name =
          (await card
            .locator("h2, h3, h4, span, [class*='name'], [class*='title']")
            .first()
            .textContent()
            .catch(() => "")) || "";

        const href =
          (await card.getAttribute("href").catch(() => "")) || "";
        const hrefParent =
          (await card
            .locator("a[href]")
            .first()
            .getAttribute("href")
            .catch(() => "")) || "";

        const link = href || hrefParent;
        const slugMatch = link.match(/\/services\/([^/?#]+)|\/m\/categories\/([^/?#]+)/);
        const slug = slugMatch?.[1] || slugMatch?.[2] || name.toLowerCase().replace(/\s+/g, "-");
        const id = slug || `category-${i}`;

        const description =
          (await card
            .locator("p, [class*='description']")
            .first()
            .textContent()
            .catch(() => "")) || "";

        if (name.trim()) {
          categories.push({
            id,
            name: name.trim(),
            slug,
            description: description.trim() || undefined,
          });
        }
      } catch {
        // skip
      }
    }

    // Fallback: extract from page text if no cards found
    if (categories.length === 0) {
      const links = p.locator('a[href*="/services/"], a[href*="/m/"]');
      const linkCount = await links.count();

      for (let i = 0; i < Math.min(linkCount, 30); i++) {
        const link = links.nth(i);
        const text = (await link.textContent().catch(() => "")) || "";
        const href = (await link.getAttribute("href").catch(() => "")) || "";
        const slugMatch = href.match(/\/services\/([^/?#]+)|\/m\/([^/?#]+)/);
        const slug = slugMatch?.[1] || slugMatch?.[2] || "";

        if (text.trim() && slug && !slug.includes("category")) {
          categories.push({
            id: slug,
            name: text.trim(),
            slug,
          });
        }
      }
    }

    await saveCookies(ctx);

    return { success: true, categories };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to search task categories",
    };
  }
}

/**
 * Get available taskers for a task type and location
 */
export async function getTaskers(
  taskType: string,
  location: string,
  options?: { sortBy?: "price" | "rating" | "reviews" }
): Promise<{ success: boolean; taskers?: Tasker[]; taskType?: string; location?: string; error?: string }> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    // TaskRabbit search URL patterns
    const encodedTask = encodeURIComponent(taskType.toLowerCase().replace(/\s+/g, "-"));
    const encodedLocation = encodeURIComponent(location);
    const url = `${TASKRABBIT_BASE_URL}/m/${encodedTask}?location=${encodedLocation}`;

    await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(4000);

    // Handle location modal if it appears
    const locationInput = p.locator(
      'input[placeholder*="location"], input[placeholder*="zip"], input[placeholder*="city"], ' +
      'input[name="location"], input[id*="location"]'
    );
    if (await locationInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await locationInput.fill(location);
      await p.waitForTimeout(1500);
      const suggestion = p.locator('[role="option"], [class*="suggestion"]').first();
      if (await suggestion.isVisible({ timeout: 3000 }).catch(() => false)) {
        await suggestion.click();
        await p.waitForTimeout(2000);
      } else {
        await locationInput.press("Enter");
        await p.waitForTimeout(2000);
      }
    }

    // Apply sort if requested
    if (options?.sortBy) {
      const sortMap: Record<string, string> = {
        price: "Hourly Rate",
        rating: "Rating",
        reviews: "Reviews",
      };
      const sortLabel = sortMap[options.sortBy];
      const sortButton = p.locator(
        `button:has-text("${sortLabel}"), [data-testid*="sort"]:has-text("${sortLabel}")`
      );
      if (await sortButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await sortButton.click();
        await p.waitForTimeout(2000);
      }
    }

    const taskers: Tasker[] = [];

    // Tasker cards
    const taskerCards = p.locator(
      '[data-testid="tasker-card"], [class*="TaskerCard"], [class*="tasker-card"], ' +
      '[class*="ProfileCard"], [class*="profile-card"]'
    );
    await taskerCards.first().waitFor({ timeout: 10000 }).catch(() => {});

    const cardCount = await taskerCards.count();

    for (let i = 0; i < Math.min(cardCount, 20); i++) {
      const card = taskerCards.nth(i);

      try {
        const name =
          (await card
            .locator(
              'h2, h3, [class*="name"], [data-testid*="name"], [class*="Name"]'
            )
            .first()
            .textContent()
            .catch(() => "")) || "";

        const ratingText =
          (await card
            .locator(
              '[class*="rating"], [data-testid*="rating"], [aria-label*="stars"], span:has-text(".")'
            )
            .first()
            .textContent()
            .catch(() => "0")) || "0";

        const reviewCountText =
          (await card
            .locator(
              '[class*="review"], [data-testid*="review"], span:has-text("review")'
            )
            .first()
            .textContent()
            .catch(() => "0")) || "0";

        const rateText =
          (await card
            .locator(
              '[class*="rate"], [class*="price"], [data-testid*="rate"], span:has-text("$")'
            )
            .first()
            .textContent()
            .catch(() => "$0")) || "$0";

        const tasksText =
          (await card
            .locator('span:has-text("task"), [class*="task-count"]')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const bio =
          (await card
            .locator('p, [class*="bio"], [class*="description"]')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const href =
          (await card
            .locator("a[href]")
            .first()
            .getAttribute("href")
            .catch(() => "")) || "";
        const slugMatch = href.match(/\/profile\/([^/?#]+)/);
        const slug = slugMatch?.[1] || "";

        const eliteEl = card.locator(
          '[class*="elite"], [class*="Elite"], span:has-text("Elite")'
        );
        const eliteStatus =
          (await eliteEl.isVisible().catch(() => false)) || false;

        const id = slug || `tasker-${i}`;

        if (name.trim()) {
          taskers.push({
            id,
            name: name.trim(),
            slug: slug || undefined,
            rating: parseFloat(ratingText.replace(/[^0-9.]/g, "")) || 0,
            reviewCount:
              parseInt(reviewCountText.replace(/[^0-9]/g, "")) || 0,
            hourlyRate:
              parseFloat(rateText.replace(/[^0-9.]/g, "")) || 0,
            tasksCompleted:
              parseInt(tasksText.replace(/[^0-9]/g, "")) || undefined,
            bio: bio.trim() || undefined,
            eliteStatus,
          });
        }
      } catch {
        // skip
      }
    }

    await saveCookies(ctx);

    return {
      success: true,
      taskers,
      taskType,
      location,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to get taskers",
    };
  }
}

/**
 * Get detailed tasker profile with reviews and availability
 */
export async function getTaskerProfile(
  taskerId: string
): Promise<{ success: boolean; profile?: TaskerProfile; error?: string }> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    const url = `${TASKRABBIT_BASE_URL}/profile/${taskerId}`;
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(3000);

    const name =
      (await p
        .locator('h1, [class*="name"], [data-testid*="name"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    const ratingText =
      (await p
        .locator('[class*="rating"], [aria-label*="stars"], [data-testid*="rating"]')
        .first()
        .textContent()
        .catch(() => "0")) || "0";

    const reviewCountText =
      (await p
        .locator('[class*="review-count"], span:has-text("review")')
        .first()
        .textContent()
        .catch(() => "0")) || "0";

    const rateText =
      (await p
        .locator('[class*="rate"], [data-testid*="rate"], span:has-text("$/hr"), span:has-text("/hr")')
        .first()
        .textContent()
        .catch(() => "$0")) || "$0";

    const tasksText =
      (await p
        .locator('span:has-text("task"), [class*="task-count"], [data-testid*="task-count"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    const bio =
      (await p
        .locator(
          '[class*="bio"], [data-testid*="bio"], [class*="about"], section:has(h2:has-text("About")) p'
        )
        .first()
        .textContent()
        .catch(() => "")) || "";

    const responseTimeText =
      (await p
        .locator('span:has-text("responds"), [class*="response"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    const eliteEl = p.locator('[class*="elite"], [class*="Elite"], span:has-text("Elite")');
    const eliteStatus = (await eliteEl.isVisible().catch(() => false)) || false;

    // Get skills/services
    const skills: string[] = [];
    const skillItems = p.locator(
      '[class*="skill"], [class*="service"], [data-testid*="skill"], ' +
      'section:has(h2:has-text("Skills")) li, section:has(h2:has-text("Services")) li'
    );
    const skillCount = await skillItems.count();
    for (let i = 0; i < Math.min(skillCount, 20); i++) {
      const text =
        (await skillItems.nth(i).textContent().catch(() => "")) || "";
      if (text.trim()) skills.push(text.trim());
    }

    // Get badges/verifications
    const badges: string[] = [];
    const badgeItems = p.locator(
      '[class*="badge"], [class*="verification"], [data-testid*="badge"]'
    );
    const badgeCount = await badgeItems.count();
    for (let i = 0; i < Math.min(badgeCount, 10); i++) {
      const text =
        (await badgeItems.nth(i).textContent().catch(() => "")) || "";
      if (text.trim()) badges.push(text.trim());
    }

    // Get reviews
    const reviews: TaskerReview[] = [];
    const reviewItems = p.locator(
      '[class*="review-item"], [class*="ReviewItem"], [data-testid*="review"]'
    );
    await reviewItems.first().waitFor({ timeout: 5000 }).catch(() => {});
    const reviewCount = await reviewItems.count();

    for (let i = 0; i < Math.min(reviewCount, 10); i++) {
      const item = reviewItems.nth(i);
      try {
        const author =
          (await item
            .locator('[class*="author"], [class*="reviewer"], strong')
            .first()
            .textContent()
            .catch(() => "")) || "Anonymous";
        const reviewRatingText =
          (await item
            .locator('[class*="rating"], [aria-label*="stars"]')
            .first()
            .textContent()
            .catch(() => "5")) || "5";
        const comment =
          (await item
            .locator("p, [class*='comment'], [class*='text']")
            .first()
            .textContent()
            .catch(() => "")) || "";
        const date =
          (await item
            .locator("time, [class*='date']")
            .first()
            .textContent()
            .catch(() => "")) || "";
        const taskType =
          (await item
            .locator('[class*="task-type"], [class*="category"]')
            .first()
            .textContent()
            .catch(() => "")) || "";

        reviews.push({
          author: author.trim(),
          rating: parseFloat(reviewRatingText.replace(/[^0-9.]/g, "")) || 5,
          comment: comment.trim(),
          date: date.trim() || undefined,
          taskType: taskType.trim() || undefined,
        });
      } catch {
        // skip
      }
    }

    await saveCookies(ctx);

    const profile: TaskerProfile = {
      id: taskerId,
      name: name.trim(),
      rating: parseFloat(ratingText.replace(/[^0-9.]/g, "")) || 0,
      reviewCount: parseInt(reviewCountText.replace(/[^0-9]/g, "")) || 0,
      hourlyRate: parseFloat(rateText.replace(/[^0-9.]/g, "")) || 0,
      tasksCompleted: parseInt(tasksText.replace(/[^0-9]/g, "")) || undefined,
      bio: bio.trim() || undefined,
      responseTime: responseTimeText.trim() || undefined,
      eliteStatus,
      skills: skills.length > 0 ? skills : undefined,
      badges: badges.length > 0 ? badges : undefined,
      reviews: reviews.length > 0 ? reviews : undefined,
    };

    return { success: true, profile };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to get tasker profile",
    };
  }
}

/**
 * Book a task with a specific tasker
 */
export async function bookTask(
  taskerId: string,
  taskType: string,
  options: {
    date: string;
    time: string;
    location: string;
    description?: string;
    confirm?: boolean;
  }
): Promise<{
  success: boolean;
  bookingId?: string;
  summary?: {
    taskerName: string;
    taskType: string;
    date: string;
    time: string;
    location: string;
    estimatedCost?: number;
  };
  requiresConfirmation?: boolean;
  error?: string;
}> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    // Navigate to tasker profile booking
    const url = `${TASKRABBIT_BASE_URL}/profile/${taskerId}`;
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(3000);

    const taskerName =
      (await p
        .locator("h1")
        .first()
        .textContent()
        .catch(() => taskerId)) || taskerId;

    // Click "Book" or "Hire" button
    const bookButton = p.locator(
      'button:has-text("Book"), button:has-text("Hire"), a:has-text("Book"), ' +
      '[data-testid*="book"], [class*="book-button"], [class*="hire-button"]'
    ).first();

    if (!(await bookButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      return {
        success: false,
        error:
          "Could not find booking button. Make sure you are logged in and the tasker is available.",
      };
    }

    await bookButton.click();
    await p.waitForTimeout(3000);

    // Fill in task details
    // Task description
    if (options.description) {
      const descInput = p.locator(
        'textarea[placeholder*="describe"], textarea[placeholder*="details"], ' +
        'textarea[name*="description"], textarea[id*="description"], ' +
        '[data-testid*="description"] textarea, [class*="task-description"] textarea'
      );
      if (await descInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await descInput.fill(options.description);
        await p.waitForTimeout(500);
      }
    }

    // Location
    const locationInput = p.locator(
      'input[placeholder*="address"], input[placeholder*="location"], ' +
      'input[name*="location"], input[id*="location"]'
    );
    if (await locationInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await locationInput.fill(options.location);
      await p.waitForTimeout(1500);
      const suggestion = p.locator('[role="option"]').first();
      if (await suggestion.isVisible({ timeout: 2000 }).catch(() => false)) {
        await suggestion.click();
        await p.waitForTimeout(1000);
      }
    }

    // Date selection
    const dateInput = p.locator(
      'input[type="date"], input[placeholder*="date"], [data-testid*="date"] input, ' +
      '[class*="date-picker"] input, [class*="DatePicker"] input'
    );
    if (await dateInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await dateInput.fill(options.date);
      await p.waitForTimeout(500);
    } else {
      // Try clicking date from calendar
      const dateText = p.locator(
        `[aria-label*="${options.date}"], td:has-text("${options.date.split("-")[2]}")`
      ).first();
      if (await dateText.isVisible({ timeout: 3000 }).catch(() => false)) {
        await dateText.click();
        await p.waitForTimeout(500);
      }
    }

    // Time selection
    const timeInput = p.locator(
      'input[type="time"], input[placeholder*="time"], [data-testid*="time"] input, ' +
      'select[name*="time"], [class*="time-picker"] input'
    );
    if (await timeInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await timeInput.fill(options.time);
      await p.waitForTimeout(500);
    } else {
      // Try selecting time from dropdown/buttons
      const timeOption = p.locator(
        `button:has-text("${options.time}"), [role="option"]:has-text("${options.time}")`
      ).first();
      if (await timeOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await timeOption.click();
        await p.waitForTimeout(500);
      }
    }

    // Get estimated cost before confirming
    const costText =
      (await p
        .locator('[class*="cost"], [class*="price"], span:has-text("$"), [data-testid*="cost"]')
        .first()
        .textContent()
        .catch(() => "")) || "";
    const estimatedCost = parseFloat(costText.replace(/[^0-9.]/g, "")) || undefined;

    const summary = {
      taskerName: taskerName.trim(),
      taskType,
      date: options.date,
      time: options.time,
      location: options.location,
      estimatedCost,
    };

    if (!options.confirm) {
      return {
        success: true,
        requiresConfirmation: true,
        summary,
      };
    }

    // Confirm and submit booking
    const confirmButton = p.locator(
      'button:has-text("Confirm"), button:has-text("Submit"), button:has-text("Book Now"), ' +
      'button[type="submit"], [data-testid*="confirm"]'
    ).first();

    await confirmButton.waitFor({ timeout: 5000 });
    await confirmButton.click();
    await p.waitForTimeout(5000);

    // Get booking ID from URL or page
    const urlMatch = p.url().match(/tasks?\/(\w+)|booking\/(\w+)|confirmation\/(\w+)/);
    const bookingId =
      urlMatch?.[1] || urlMatch?.[2] || urlMatch?.[3] || `booking-${Date.now()}`;

    await saveCookies(ctx);

    return {
      success: true,
      bookingId,
      summary,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to book task",
    };
  }
}

/**
 * Get booked/active tasks
 */
export async function getTasks(
  filter?: "active" | "completed" | "all"
): Promise<{ success: boolean; tasks?: BookedTask[]; error?: string }> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    await p.goto(`${TASKRABBIT_BASE_URL}/dashboard/tasks`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await p.waitForTimeout(3000);

    // Apply filter if provided
    if (filter && filter !== "all") {
      const filterMap: Record<string, string> = {
        active: "Active",
        completed: "Completed",
      };
      const filterLabel = filterMap[filter];
      const filterButton = p.locator(
        `button:has-text("${filterLabel}"), a:has-text("${filterLabel}"), ` +
        `[data-testid*="filter"]:has-text("${filterLabel}")`
      );
      if (await filterButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await filterButton.click();
        await p.waitForTimeout(2000);
      }
    }

    const tasks: BookedTask[] = [];

    const taskCards = p.locator(
      '[data-testid*="task-card"], [class*="TaskCard"], [class*="task-card"], ' +
      '[class*="TaskItem"], [class*="task-item"]'
    );
    await taskCards.first().waitFor({ timeout: 8000 }).catch(() => {});
    const cardCount = await taskCards.count();

    for (let i = 0; i < Math.min(cardCount, 30); i++) {
      const card = taskCards.nth(i);

      try {
        const taskType =
          (await card
            .locator("h2, h3, [class*='title'], [class*='type']")
            .first()
            .textContent()
            .catch(() => "")) || "";

        const status =
          (await card
            .locator('[class*="status"], [data-testid*="status"], span:has-text("Scheduled"), span:has-text("Completed"), span:has-text("Active")')
            .first()
            .textContent()
            .catch(() => "")) || "Unknown";

        const taskerName =
          (await card
            .locator('[class*="tasker"], [class*="provider"], span:has-text("with")')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const date =
          (await card
            .locator("time, [class*='date'], [data-testid*='date']")
            .first()
            .textContent()
            .catch(() => "")) || "";

        const priceText =
          (await card
            .locator('span:has-text("$"), [class*="price"], [class*="cost"]')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const href =
          (await card
            .locator("a[href]")
            .first()
            .getAttribute("href")
            .catch(() => "")) || "";
        const idMatch = href.match(/tasks?\/(\w+)/);
        const id = idMatch?.[1] || `task-${i}`;

        if (taskType.trim() || id !== `task-${i}`) {
          tasks.push({
            id,
            status: status.trim() || "Unknown",
            taskType: taskType.trim() || "Unknown",
            taskerName: taskerName.replace(/^with\s+/i, "").trim(),
            scheduledDate: date.trim() || undefined,
            price: parseFloat(priceText.replace(/[^0-9.]/g, "")) || undefined,
          });
        }
      } catch {
        // skip
      }
    }

    await saveCookies(ctx);

    return { success: true, tasks };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to get tasks",
    };
  }
}

/**
 * Send a message to a tasker
 */
export async function messageTasker(
  taskerId: string,
  message: string,
  taskId?: string
): Promise<{ success: boolean; error?: string }> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    // Navigate to inbox or specific conversation
    let url = `${TASKRABBIT_BASE_URL}/inbox`;
    if (taskId) {
      url = `${TASKRABBIT_BASE_URL}/inbox/${taskId}`;
    }

    await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(3000);

    // If on inbox list, find the conversation with this tasker
    if (!taskId) {
      const conversation = p.locator(
        `[class*="conversation"]:has-text("${taskerId}"), ` +
        `[class*="thread"]:has-text("${taskerId}"), ` +
        `[data-testid*="conversation"]`
      ).first();

      if (await conversation.isVisible({ timeout: 5000 }).catch(() => false)) {
        await conversation.click();
        await p.waitForTimeout(2000);
      }
    }

    // Find message input
    const messageInput = p.locator(
      'textarea[placeholder*="message"], textarea[placeholder*="Message"], ' +
      'input[placeholder*="message"], [contenteditable="true"], ' +
      '[data-testid*="message-input"], [class*="message-input"]'
    );

    await messageInput.waitFor({ timeout: 5000 });
    await messageInput.fill(message);
    await p.waitForTimeout(500);

    // Send the message
    const sendButton = p.locator(
      'button:has-text("Send"), button[type="submit"], ' +
      '[data-testid*="send"], [aria-label*="Send"]'
    ).first();

    await sendButton.waitFor({ timeout: 3000 });
    await sendButton.click();
    await p.waitForTimeout(2000);

    await saveCookies(ctx);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to send message",
    };
  }
}

/**
 * Cancel a task
 */
export async function cancelTask(
  taskId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    const url = `${TASKRABBIT_BASE_URL}/dashboard/tasks/${taskId}`;
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(3000);

    // Find cancel button
    const cancelButton = p.locator(
      'button:has-text("Cancel"), [data-testid*="cancel"], ' +
      'a:has-text("Cancel Task"), [class*="cancel"]'
    ).first();

    if (!(await cancelButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      return {
        success: false,
        error:
          "Cancel option not found. The task may not be cancellable or may already be completed.",
      };
    }

    await cancelButton.click();
    await p.waitForTimeout(2000);

    // Handle cancellation reason if prompted
    if (reason) {
      const reasonInput = p.locator(
        'textarea[placeholder*="reason"], textarea[placeholder*="Reason"], ' +
        'select[name*="reason"], [data-testid*="cancel-reason"]'
      );
      if (await reasonInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        const tagName = await reasonInput.evaluate((el) => el.tagName.toLowerCase());
        if (tagName === "select") {
          await reasonInput.selectOption({ label: reason });
        } else {
          await reasonInput.fill(reason);
        }
        await p.waitForTimeout(500);
      }
    }

    // Confirm cancellation
    const confirmCancelButton = p.locator(
      'button:has-text("Confirm Cancel"), button:has-text("Yes, Cancel"), ' +
      'button:has-text("Cancel Task"), [data-testid*="confirm-cancel"]'
    ).first();

    if (await confirmCancelButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmCancelButton.click();
      await p.waitForTimeout(3000);
    }

    await saveCookies(ctx);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to cancel task",
    };
  }
}

/**
 * Login prompt - returns URL and instructions for user to log in
 */
export async function getLoginUrl(): Promise<{ url: string; instructions: string }> {
  const p = await getPage();
  await p.goto(`${TASKRABBIT_BASE_URL}/login`, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT,
  });

  return {
    url: `${TASKRABBIT_BASE_URL}/login`,
    instructions:
      "Please log in to TaskRabbit in your browser. After logging in, run the 'taskrabbit_auth_check' tool to verify authentication and save your session.",
  };
}

/**
 * Cleanup browser resources
 */
export async function cleanup(): Promise<void> {
  if (context) {
    await saveCookies(context);
  }
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    page = null;
  }
}
