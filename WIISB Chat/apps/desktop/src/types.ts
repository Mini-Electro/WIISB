export type User = {
  id: string;
  username: string;
  display_name: string;
  avatar_id?: string;
  banner_id?: string;
  /** How the pictures are framed: zoom (1 = fit), focal point in %, banner height in px. */
  avatar_zoom?: number;
  avatar_x?: number;
  avatar_y?: number;
  banner_zoom?: number;
  banner_x?: number;
  banner_y?: number;
  banner_height?: number;
  bio?: string;
  pronouns?: string;
  status?: string;
  presence?: string;
  accent?: string;
  settings?: {
    dmPolicy?: string;
    friendRequests?: boolean;
    notifications?: boolean;
  };
};
export type Channel = {
  id: string;
  server_id?: string;
  owner_id?: string;
  name: string;
  kind: string;
  topic?: string;
  category?: string;
  private?: boolean;
  allowed_roles?: string[];
  position?: number;
  slow_mode?: number;
  unread?: number;
  members?: User[];
};
export type Community = {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  channels: Channel[];
  members: (User & { roles: string[]; timeout_until?: string })[];
  roles: Role[];
  myPermissions: string[];
  owner: boolean;
  accent?: string;
};
export type Role = {
  id: string;
  name: string;
  color: string;
  position: number;
  permissions: string[];
  is_default: boolean;
};
export type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  thumbnail: boolean;
};
export type Message = {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  nonce: string;
  reply_id?: string;
  reply?: { id: string; content: string; display_name: string };
  display_name: string;
  username: string;
  avatar_id?: string;
  avatar_zoom?: number;
  avatar_x?: number;
  avatar_y?: number;
  pinned: boolean;
  created_at: string;
  edited_at?: string;
  attachments: Attachment[];
  reactions: { emoji: string; users: string[] }[];
};
export type FriendState = {
  friends: User[];
  incoming: User[];
  outgoing: User[];
  blocked: User[];
};
export type Session = { access: string; refresh: string; user: User };
export type Event = {
  v: number;
  type: string;
  resourceId?: string;
  payload: any;
};
