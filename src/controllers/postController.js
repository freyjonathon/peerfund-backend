// controllers/postController.js
const prisma = require('../utils/prisma');

// GET /api/posts  (public read)
exports.getAllPosts = async (_req, res) => {
  try {
    const posts = await prisma.post.findMany({
      include: {
        user: { select: { id: true, name: true } }, // <- relation name is "author"
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(posts);
  } catch (err) {
    console.error('Error fetching posts:', err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
};

// POST /api/posts (auth required)
exports.createPost = async (req, res) => {
  const userId = req.user?.userId;
  const content = (req.body?.content || '').trim();

  if (!userId) return res.status(401).json({ error: 'Login required' });
  if (!content) return res.status(400).json({ error: 'Content required' });

  try {
    const post = await prisma.post.create({
      data: {
        content,
        userId: userId, // <- FK matches the relation name
      },
      include: { user: { select: { id: true, name: true } } },
    });
    res.status(201).json(post);
  } catch (err) {
    console.error('Error creating post:', err);
    res.status(500).json({ error: 'Failed to create post' });
  }
};
