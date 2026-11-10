import { useState } from 'react';

export function useAuth() {
  const [user, setUser] = useState<string | null>(null);
  return { user, setUser };
}
