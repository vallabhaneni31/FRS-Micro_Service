import {
  LayoutDashboard, Building, Building2, Users, Globe, BarChart3,
  Shield, Activity, Server, Settings, Clock, Calendar, FileText,
  UserPlus, UserCog, Cpu, MapPin, Bell, UsersRound, Tag, Camera, LucideIcon,
  Bus, Route, History
} from 'lucide-react';

const ICON_MAP: Record<string, LucideIcon> = {
  LayoutDashboard,
  Building,
  Building2,
  Users,
  UsersRound,
  Tag,
  Globe,
  BarChart3,
  Shield,
  Activity,
  Server,
  Settings,
  Clock,
  Calendar,
  FileText,
  UserPlus,
  UserCog,
  Cpu,
  MapPin,
  Bell,
  Bus,
  Route,
  History,
  Camera,
};

export function getIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? LayoutDashboard;
}
