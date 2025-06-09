import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../utils/supabase'

const AuthContext = createContext({})

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [organizationId, setOrganizationId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    // Get initial session
    const getInitialSession = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession()
        if (error) throw error
        
        if (session?.user) {
          setUser(session.user)
          await fetchUserOrganization(session.user.id)
        }
      } catch (error) {
        console.error('Error getting initial session:', error)
        setError(error.message)
      } finally {
        setLoading(false)
      }
    }

    getInitialSession()

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        setUser(session.user)
        await fetchUserOrganization(session.user.id)
      } else {
        setUser(null)
        setOrganizationId(null)
      }
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  const fetchUserOrganization = async (userId) => {
    try {
      const { data, error } = await supabase
        .from('organization_users')
        .select('organization_id')
        .eq('user_id', userId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          // No organization found for user
          console.warn('No organization found for user:', userId)
          setOrganizationId(null)
        } else {
          throw error
        }
      } else {
        setOrganizationId(data.organization_id)
      }
    } catch (error) {
      console.error('Error fetching user organization:', error)
      setError(error.message)
    }
  }

  const signIn = async (email, password) => {
    try {
      setError(null)
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (error) throw error
      return data
    } catch (error) {
      setError(error.message)
      throw error
    }
  }

  const signUp = async (email, password) => {
    try {
      setError(null)
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      })
      if (error) throw error
      return data
    } catch (error) {
      setError(error.message)
      throw error
    }
  }

  const signOut = async () => {
    try {
      setError(null)
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    } catch (error) {
      setError(error.message)
      throw error
    }
  }

  const value = {
    user,
    organizationId,
    loading,
    error,
    signIn,
    signUp,
    signOut,
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}
