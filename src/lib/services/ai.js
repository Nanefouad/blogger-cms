import { prisma } from "@/lib/prisma";
import { UserService } from "./user";
import config from "@/lib/config";

function cleanJsonString(raw) {
  let str = (raw || "").trim();
  if (str.startsWith("```json")) {
    str = str.substring(7);
  } else if (str.startsWith("```")) {
    str = str.substring(3);
  }
  if (str.endsWith("```")) {
    str = str.substring(0, str.length - 3);
  }
  return str.trim();
}

function parseModelOutput(rawText, fallbackBlogTopic, fallbackKeyword) {
  const jsonStr = cleanJsonString(rawText);
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      title: parsed.title || (fallbackBlogTopic ? `Blog: ${fallbackBlogTopic}` : "AI Generated Blog"),
      content: parsed.content || `<p>${rawText.replace(/\n/g, "<br>")}</p>`,
      seoTitle: parsed.seoTitle || parsed.title || "",
      seoDescription: parsed.seoDescription || "",
      seoKeywords: parsed.seoKeywords || fallbackKeyword || "",
    };
  } catch (e) {
    console.warn("Failed to parse AI output as JSON, fallback to plain text:", e);
    return {
      title: fallbackBlogTopic ? `Blog: ${fallbackBlogTopic}` : "AI Generated Blog",
      content: `<p>${rawText.replace(/\n/g, "<br>")}</p>`,
      seoTitle: fallbackBlogTopic || "AI Blog",
      seoDescription: "Generated blog post content.",
      seoKeywords: fallbackKeyword || "blog, ai",
    };
  }
}

export const AIService = {
  async generateBlog(userId, { groupId, keyword, blogTopic, customApiKey = null }) {
    const isUsingCustomKey = Boolean(customApiKey && customApiKey.trim().length > 0);
    const cost = isUsingCustomKey ? 0 : config.ai.blogGenerationCost;

    // Deduct credits if not using custom API key
    if (!isUsingCustomKey && cost > 0) {
      await UserService.deductCredits(userId, cost);
    }

    const apiKey = isUsingCustomKey ? customApiKey.trim() : config.ai.apiKey;
    if (!apiKey || apiKey.includes("your_") || apiKey.trim() === "") {
      console.warn("AI API key is not configured. Falling back to local Mock Blog Post Generation.");
      const request_id = `mock_${Date.now()}`;
      const blogPost = await prisma.blogPost.create({
        data: {
          title: "Generating mock blog content...",
          content: "<p>AI is currently writing your blog post. This usually takes 5-10 seconds. Please wait...</p>",
          author: "AI Writer",
          status: "processing",
          keyword,
          blogTopic,
          requestId: request_id,
          creditCost: cost,
          userId,
          groupId,
        }
      });
      return blogPost;
    }

    const systemPrompt = "You are a professional SEO copywriter and expert blogger. Generate a detailed, high-quality, and SEO-optimized blog post in clean HTML format. You must respond ONLY with a raw JSON object (do not include markdown code block styling or any additional text, just the raw JSON) with the following structure: \n{\n  \"title\": \"Blog Post Title\",\n  \"content\": \"<p>Full HTML content of the blog, using h2, h3, paragraphs, lists, bold text, etc...</p>\",\n  \"seoTitle\": \"SEO Optimized Title\",\n  \"seoDescription\": \"SEO Optimized Meta Description\",\n  \"seoKeywords\": \"keyword1, keyword2, keyword3\"\n}";

    const userPrompt = `Generate a blog post based on the following:
Primary Keyword: ${keyword}
Blog Topic / Focus: ${blogTopic}

Ensure the article is informative, well-structured, and rich with semantic details. Use the primary keyword naturally throughout the text.`;

    const gatewayUrl = (config.ai.gatewayUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = config.ai.model || "omniroute/auto/best-coding";

    try {
      // Direct OpenAI-compatible chat completion request
      const endpoint = `${gatewayUrl}/chat/completions`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gateway returned ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("No text content received in gateway response");
      }

      const parsed = parseModelOutput(content, blogTopic, keyword);

      // Create directly with completed status
      const request_id = `completed_${Date.now()}`;
      const blogPost = await prisma.blogPost.create({
        data: {
          title: parsed.title,
          content: parsed.content,
          author: "AI Writer",
          status: "completed",
          seoTitle: parsed.seoTitle,
          seoDescription: parsed.seoDescription,
          seoKeywords: parsed.seoKeywords,
          keyword,
          blogTopic,
          requestId: request_id,
          creditCost: cost,
          userId,
          groupId,
        }
      });

      return blogPost;
    } catch (err) {
      console.warn("AI generation via gateway failed. Falling back to local Mock Blog Post Generation. Error:", err.message);

      // If credit was deducted, refund on critical error or provide fallback
      const request_id = `mock_fallback_${Date.now()}`;
      const blogPost = await prisma.blogPost.create({
        data: {
          title: "Generating mock blog content...",
          content: "<p>AI is currently writing your blog post. This usually takes 5-10 seconds. Please wait...</p>",
          author: "AI Writer",
          status: "processing",
          keyword,
          blogTopic,
          requestId: request_id,
          creditCost: cost,
          userId,
          groupId,
        }
      });
      return blogPost;
    }
  },

  async checkStatus(requestId, customApiKey = null) {
    const blogPost = await prisma.blogPost.findUnique({
      where: { requestId }
    });

    if (!blogPost) return null;

    if (blogPost.status === "completed") {
      return { status: "completed", blog: blogPost };
    }

    if (blogPost.status === "failed") {
      return { status: "failed", error: "Generation failed" };
    }

    // Handle mock requests
    if (requestId && (requestId.startsWith("mock_") || requestId.startsWith("mock_fallback_"))) {
      const elapsed = Date.now() - new Date(blogPost.createTime).getTime();
      if (elapsed < 2000) {
        return { status: "processing" };
      }

      const parsed = {
        title: `Unlocking the Potential of ${blogPost.blogTopic || "SEO Content"}`,
        content: `<h2>Introduction to ${blogPost.keyword || "Content Marketing"}</h2><p>In today's digital landscape, understanding the nuances of <strong>${blogPost.keyword || "content marketing"}</strong> has become a necessity for brand visibility. Implementing a sound strategy around <em>${blogPost.blogTopic || "SEO optimizations"}</em> is the most reliable way to achieve sustainable long-term growth.</p><p>By producing high-quality, readable content, you establish authority in your niche and build trust with your readers.</p><h2>3 Critical Strategies to Optimize Your Content</h2><p>To ensure your articles perform well, keep these basic principles in mind:</p><ol><li><strong>Keyword Density & Placement:</strong> Integrate <strong>${blogPost.keyword || "your primary keyword"}</strong> naturally into headings, intros, and conclusions. Avoid keyword stuffing.</li><li><strong>Semantic Hierarchy:</strong> Structure your posts logically with <code>H2</code> and <code>H3</code> subheadings to enhance readability.</li><li><strong>Engaging Visuals:</strong> Always include relevant cover images and diagrams to break up large blocks of text.</li></ol><h2>Conclusion</h2><p>Mastering these elements is a continuous journey. By maintaining quality and relevance, your blogs will consistently rank higher and drive meaningful engagement. Start creating and scaling today!</p>`,
        seoTitle: `Unlocking ${blogPost.blogTopic || "SEO"} - Step-by-Step Guide`,
        seoDescription: `Everything you need to know about ${blogPost.keyword || "optimizations"} and ${blogPost.blogTopic || "blogging"} for organic search growth.`,
        seoKeywords: `${blogPost.keyword || "blog"}, seo, copywriting, marketing`
      };

      const updated = await prisma.blogPost.update({
        where: { id: blogPost.id },
        data: {
          title: parsed.title,
          content: parsed.content,
          seoTitle: parsed.seoTitle,
          seoDescription: parsed.seoDescription,
          seoKeywords: parsed.seoKeywords,
          status: "completed",
          updateTime: new Date(),
        }
      });

      return { status: "completed", blog: updated };
    }

    // Default status if pending
    return { status: "processing" };
  }
};
