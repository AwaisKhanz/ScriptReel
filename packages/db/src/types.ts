export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      asset_cache: {
        Row: {
          author: string | null
          bytes: number | null
          checksum: string | null
          duration: number | null
          height: number | null
          id: string
          kind: Database["public"]["Enums"]["media_kind"]
          last_used_at: string
          license: string | null
          local_path: string
          page_url: string | null
          provider: string
          provider_id: string
          width: number | null
        }
        Insert: {
          author?: string | null
          bytes?: number | null
          checksum?: string | null
          duration?: number | null
          height?: number | null
          id?: string
          kind: Database["public"]["Enums"]["media_kind"]
          last_used_at?: string
          license?: string | null
          local_path: string
          page_url?: string | null
          provider: string
          provider_id: string
          width?: number | null
        }
        Update: {
          author?: string | null
          bytes?: number | null
          checksum?: string | null
          duration?: number | null
          height?: number | null
          id?: string
          kind?: Database["public"]["Enums"]["media_kind"]
          last_used_at?: string
          license?: string | null
          local_path?: string
          page_url?: string | null
          provider?: string
          provider_id?: string
          width?: number | null
        }
        Relationships: []
      }
      beats: {
        Row: {
          chosen_candidate_id: string | null
          emotion: string | null
          entities: Json | null
          est_seconds: number | null
          forced_textcard: boolean
          id: string
          idx: number
          key_phrase: string | null
          narration: Json | null
          project_id: string
          queries: Json | null
          segments: Json | null
          shot_type: string | null
          text: string
          visual_description: string | null
          visual_moments: Json | null
        }
        Insert: {
          chosen_candidate_id?: string | null
          emotion?: string | null
          entities?: Json | null
          est_seconds?: number | null
          forced_textcard?: boolean
          id?: string
          idx: number
          key_phrase?: string | null
          narration?: Json | null
          project_id: string
          queries?: Json | null
          segments?: Json | null
          shot_type?: string | null
          text: string
          visual_description?: string | null
          visual_moments?: Json | null
        }
        Update: {
          chosen_candidate_id?: string | null
          emotion?: string | null
          entities?: Json | null
          est_seconds?: number | null
          forced_textcard?: boolean
          id?: string
          idx?: number
          key_phrase?: string | null
          narration?: Json | null
          project_id?: string
          queries?: Json | null
          segments?: Json | null
          shot_type?: string | null
          text?: string
          visual_description?: string | null
          visual_moments?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "beats_chosen_fk"
            columns: ["chosen_candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "beats_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      candidates: {
        Row: {
          author: string | null
          beat_id: string
          duration: number | null
          height: number | null
          id: string
          kind: Database["public"]["Enums"]["media_kind"]
          license: string | null
          meta: Json | null
          page_url: string | null
          provider: string
          provider_id: string
          rank: number | null
          remote_url: string | null
          score: number | null
          thumb_path: string | null
          width: number | null
        }
        Insert: {
          author?: string | null
          beat_id: string
          duration?: number | null
          height?: number | null
          id?: string
          kind: Database["public"]["Enums"]["media_kind"]
          license?: string | null
          meta?: Json | null
          page_url?: string | null
          provider: string
          provider_id: string
          rank?: number | null
          remote_url?: string | null
          score?: number | null
          thumb_path?: string | null
          width?: number | null
        }
        Update: {
          author?: string | null
          beat_id?: string
          duration?: number | null
          height?: number | null
          id?: string
          kind?: Database["public"]["Enums"]["media_kind"]
          license?: string | null
          meta?: Json | null
          page_url?: string | null
          provider?: string
          provider_id?: string
          rank?: number | null
          remote_url?: string | null
          score?: number | null
          thumb_path?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "candidates_beat_id_fkey"
            columns: ["beat_id"]
            isOneToOne: false
            referencedRelation: "beats"
            referencedColumns: ["id"]
          },
        ]
      }
      music_tracks: {
        Row: {
          bpm: number | null
          credit: string | null
          duration: number | null
          id: string
          license: string
          moods: string[]
          path: string
          title: string
        }
        Insert: {
          bpm?: number | null
          credit?: string | null
          duration?: number | null
          id: string
          license?: string
          moods: string[]
          path: string
          title: string
        }
        Update: {
          bpm?: number | null
          credit?: string | null
          duration?: number | null
          id?: string
          license?: string
          moods?: string[]
          path?: string
          title?: string
        }
        Relationships: []
      }
      pipeline_runs: {
        Row: {
          attempt: number
          detail: string | null
          error: Json | null
          finished_at: string | null
          id: string
          progress: number
          project_id: string
          stage: Database["public"]["Enums"]["pipeline_stage"]
          started_at: string | null
          status: Database["public"]["Enums"]["run_status"]
        }
        Insert: {
          attempt?: number
          detail?: string | null
          error?: Json | null
          finished_at?: string | null
          id?: string
          progress?: number
          project_id: string
          stage: Database["public"]["Enums"]["pipeline_stage"]
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
        }
        Update: {
          attempt?: number
          detail?: string | null
          error?: Json | null
          finished_at?: string | null
          id?: string
          progress?: number
          project_id?: string
          stage?: Database["public"]["Enums"]["pipeline_stage"]
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_runs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          cancel_requested: boolean
          created_at: string
          error: Json | null
          id: string
          language: string | null
          script: string
          settings: Json
          settings_hash: string | null
          status: Database["public"]["Enums"]["project_status"]
          title: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          cancel_requested?: boolean
          created_at?: string
          error?: Json | null
          id?: string
          language?: string | null
          script: string
          settings?: Json
          settings_hash?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          title: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          cancel_requested?: boolean
          created_at?: string
          error?: Json | null
          id?: string
          language?: string | null
          script?: string
          settings?: Json
          settings_hash?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          title?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      provider_usage: {
        Row: {
          provider: string
          requests: number
          window_start: string
        }
        Insert: {
          provider: string
          requests?: number
          window_start: string
        }
        Update: {
          provider?: string
          requests?: number
          window_start?: string
        }
        Relationships: []
      }
      renders: {
        Row: {
          aspect: string
          bytes: number | null
          created_at: string
          duration: number | null
          id: string
          path: string
          preset: string
          project_id: string
          thumbnail_path: string | null
          timeline: Json
        }
        Insert: {
          aspect: string
          bytes?: number | null
          created_at?: string
          duration?: number | null
          id?: string
          path: string
          preset: string
          project_id: string
          thumbnail_path?: string | null
          timeline: Json
        }
        Update: {
          aspect?: string
          bytes?: number | null
          created_at?: string
          duration?: number | null
          id?: string
          path?: string
          preset?: string
          project_id?: string
          thumbnail_path?: string | null
          timeline?: Json
        }
        Relationships: [
          {
            foreignKeyName: "renders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      media_kind: "video" | "image" | "generated" | "textcard"
      pipeline_stage:
        | "analyze"
        | "search"
        | "score"
        | "tts"
        | "align"
        | "fetch"
        | "compose"
      project_status:
        | "draft"
        | "queued"
        | "running"
        | "awaiting_review"
        | "failed"
        | "done"
      run_status: "pending" | "running" | "done" | "failed" | "skipped"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      media_kind: ["video", "image", "generated", "textcard"],
      pipeline_stage: [
        "analyze",
        "search",
        "score",
        "tts",
        "align",
        "fetch",
        "compose",
      ],
      project_status: [
        "draft",
        "queued",
        "running",
        "awaiting_review",
        "failed",
        "done",
      ],
      run_status: ["pending", "running", "done", "failed", "skipped"],
    },
  },
} as const
