const prisma = require('../utils/prisma');

exports.getAllUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, phone: true, role: true, createdAt: true }
    });
    res.status(200).json(users);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
};

exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, role } = req.body;

  try {
    const updatedUser = await prisma.user.update({
      where: { id },
      data: { name, email, phone, role }
    });
    res.status(200).json(updatedUser);
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

exports.deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    await prisma.user.delete({ where: { id } });
    res.status(200).json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

exports.makeSuperUser = async (req, res) => {
  const { userId } = req.params;

  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        isSuperUser: true,
        superUserSince: new Date()
      }
    });

    res.json({ message: 'User upgraded to Super User.' });
  } catch (err) {
    console.error('Failed to upgrade user:', err);
    res.status(500).json({ error: 'Could not upgrade user.' });
  }
};